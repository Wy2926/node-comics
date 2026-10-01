import { useEffect, useRef } from 'react';
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
  useEffect(() => {
    let gone = false,
      id: string | undefined;
    void load()
      .then(() => {
        if (gone || !host.current) return;
        id = window.turnstile!.render(host.current, {
          sitekey: siteKey,
          action,
          theme: 'auto',
          size: host.current.clientWidth < 300 ? 'compact' : 'normal',
          appearance: 'interaction-only',
          callback: (value: string) => token.current(value),
          'expired-callback': () => error.current(),
          'error-callback': () => {
            error.current();
            return true;
          },
        });
      })
      .catch(() => error.current());
    return () => {
      gone = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, action]);
  return <div ref={host} className="translation-turnstile" />;
}
