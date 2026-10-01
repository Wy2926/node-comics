import { useEffect, useRef, useState } from 'react';
interface Widget {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: Widget;
  }
}
let script: Promise<void> | undefined;
function load() {
  return (script ??= new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const tag = document.createElement('script');
    tag.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => {
      tag.remove();
      script = undefined;
      reject(Error('VERIFICATION_UNAVAILABLE'));
    };
    document.head.append(tag);
  }));
}
export default function Turnstile({
  siteKey,
  action,
  onToken,
  onError,
}: {
  siteKey: string;
  action: string;
  onToken: (value: string) => void;
  onError: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    token = useRef(onToken),
    error = useRef(onError);
  token.current = onToken;
  error.current = onError;
  const [phase, setPhase] = useState('loading');
  const [size, setSize] = useState<'normal' | 'compact'>('normal');
  useEffect(() => {
    let gone = false,
      id: string | undefined;
    const fail = () => {
      if (gone) return;
      setPhase('failed');
      error.current();
    };
    setPhase('loading');
    void load()
      .then(() => {
        if (gone || !host.current) return;
        const widgetSize = host.current.clientWidth < 300 ? 'compact' : 'normal';
        setSize(widgetSize);
        setPhase('checking');
        id = window.turnstile!.render(host.current, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          size: widgetSize,
          appearance: 'always',
          callback: (value: string) => {
            if (gone) return;
            setPhase('complete');
            token.current(value);
          },
          'before-interactive-callback': () => {
            if (!gone) setPhase('interactive');
          },
          'after-interactive-callback': () => {
            if (!gone) setPhase((value) => value === 'complete' ? value : 'checking');
          },
          'expired-callback': fail,
          'timeout-callback': fail,
          'unsupported-callback': fail,
          'error-callback': () => {
            fail();
            return true;
          },
        });
      })
      .catch(fail);
    return () => {
      gone = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, action]);
  return (
    <div className="translation-turnstile" data-state={phase} data-size={size}
      aria-busy={phase === 'loading' || phase === 'checking'}>
      <div className="translation-turnstile-progress" aria-hidden="true">
        <span className="translation-turnstile-spinner" />
      </div>
      <div ref={host} className="translation-turnstile-widget" />
    </div>
  );
}
