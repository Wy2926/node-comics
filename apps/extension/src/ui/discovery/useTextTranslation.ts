import {useEffect, useRef, useState} from 'react';
import {TextTranslationError, type TextTranslationSession} from '../../text-translation';

export function useTextTranslation(session: TextTranslationSession, text: string, language: string, enabled: boolean, automatic = true) {
  const key = JSON.stringify([text, language]);
  const [request, setRequest] = useState({key, attempt: 0}), failed = useRef('');
  // A manual request belongs to this field and language, never to the next input.
  if (request.key !== key) {
    failed.current = '';
    setRequest({key, attempt: 0});
  }
  const attempt = request.key === key ? request.attempt : 0;
  const requested = enabled && (automatic || attempt > 0);
  const [result, setResult] = useState<{key: string; text?: string; pending?: boolean; error?: TextTranslationError}>({key});
  useEffect(() => {
    if (!requested || !text || failed.current === key + attempt) return;
    failed.current = '';
    const controller = new AbortController();
    setResult({key, pending: true});
    void session.translate(text, language, controller.signal).then(translated => {
      if (!controller.signal.aborted) setResult({key, text: translated});
    }).catch(error => {
      if (controller.signal.aborted) return;
      failed.current = key + attempt;
      setResult({key, error: error instanceof TextTranslationError ? error : new TextTranslationError('unavailable')});
    });
    return () => controller.abort();
  }, [session, text, language, requested, key, attempt]);
  return {...(result.key === key ? requested ? result : {key, text: result.text} : {key}), retry: () => setRequest(value => ({key, attempt: value.key === key ? value.attempt + 1 : 1}))};
}
