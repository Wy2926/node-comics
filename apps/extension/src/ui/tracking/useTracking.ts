import {useCallback, useEffect, useRef, useState} from 'react';
import {trackingClient, type TrackingView} from '../../tracking/client';
import {trackingFailure} from './presentation';

/** Refresh only while mounted, on domain notifications or user focus; no tracker polling. */
export function useTracking(comicId?: string) {
  const [view, setView] = useState<TrackingView>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const lifetime = useRef(0), request = useRef(0), operation = useRef(0), locked = useRef(false);
  const readStatus = useCallback(async () => {
    const generation = lifetime.current, revision = ++request.current;
    try {
      const next = await trackingClient.status(comicId);
      if (generation === lifetime.current && revision === request.current) { setView(next); setStatusError(''); }
    } catch (error) {
      if (generation === lifetime.current && revision === request.current) setStatusError(trackingFailure(error));
    }
  }, [comicId]);
  // A passive status read must not erase a failed authorization or other command.
  const refresh = useCallback(async () => {
    setError(''); setStatusError('');
    await readStatus();
  }, [readStatus]);
  useEffect(() => {
    lifetime.current++; operation.current++; locked.current = false;
    setView(undefined); setError(''); setStatusError(''); setBusy(false);
    void readStatus();
    const changed = () => { void readStatus(); };
    const unsubscribe = trackingClient.subscribe(changed);
    window.addEventListener('focus', changed);
    return () => { lifetime.current++; unsubscribe(); window.removeEventListener('focus', changed); };
  }, [readStatus]);
  async function run(action: () => Promise<void>, interrupt = false): Promise<boolean> {
    if (locked.current && !interrupt) return false;
    locked.current = true; request.current++;
    setBusy(true); setError(''); setStatusError('');
    const generation = lifetime.current, revision = ++operation.current;
    try {
      await action();
      if (generation !== lifetime.current || revision !== operation.current) return false;
      await readStatus();
      return generation === lifetime.current && revision === operation.current;
    } catch (error) {
      if (generation === lifetime.current && revision === operation.current) setError(trackingFailure(error));
      return false;
    } finally {
      if (revision === operation.current) {
        locked.current = false;
        if (generation === lifetime.current) setBusy(false);
      }
    }
  }
  return {view, error: error || statusError, busy, refresh, run};
}
