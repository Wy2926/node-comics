import {useEffect, useState} from 'react';
import {DiscoveryError} from '../../discovery/types';

export function useWorkRequest<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{value?: T; error?: DiscoveryError; loading: boolean}>({loading: true});
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({value: previous.value, loading: true}));
    void read(controller.signal).then(value => {
      if (!controller.signal.aborted) setState({value, loading: false});
    }).catch(error => {
      if (!controller.signal.aborted) setState(previous => ({...previous, loading: false,
        error: error instanceof DiscoveryError ? error : new DiscoveryError('unavailable')}));
    });
    return () => controller.abort();
  }, [read, attempt]);
  return {...state, retry: () => setAttempt(n => n + 1)};
}
