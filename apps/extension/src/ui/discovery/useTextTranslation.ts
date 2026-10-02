import {useEffect, useRef, useState} from 'react';
import {TextTranslationError, type TextTranslationSession} from '../../text-translation';

export function useTextTranslation(session: TextTranslationSession, text: string, language: string, enabled: boolean) {
  const key = JSON.stringify([text, language]);
  const [attempt, setAttempt] = useState(0), failed = useRef('');
  const [result, setResult] = useState<{key: string; text?: string; pending?: boolean; error?: TextTranslationError}>({key});
  useEffect(() => {
    if (!enabled || !text || failed.current === key + attempt) return;
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
  }, [session, text, language, enabled, key, attempt]);
  return {...(result.key === key ? enabled ? result : {key, text: result.text} : {key}), retry: () => setAttempt(value => value + 1)};
}
