export function historyPollDelay(states: string[]): number | null {
  if (states.some(state => ['awaiting_upload','validating_upload','queued','running'].includes(state))) return 15_000;
  if (states.includes('outcome_unknown')) return 60_000;
  return null;
}

/** One request at a time; completed history stays idle until refresh/visibility. */
export function pollVisibleHistory<T>(options: {
  load: () => Promise<T>;
  receive: (value: T) => void;
  error: (error: Error) => void;
  delay: (value: T) => number | null;
  current: () => boolean;
}): () => void {
  let stopped = false;
  let pending = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => !stopped && options.current();
  async function fetchPage() {
    if (!current() || pending || document.hidden) return;
    clearTimeout(timer);
    pending = true;
    let delay: number | null = null;
    try {
      const value = await options.load();
      if (!current()) return;
      failures = 0;
      options.receive(value);
      delay = options.delay(value);
    } catch (error) {
      if (!current()) return;
      options.error(error as Error);
      delay = Math.min(120_000, 30_000 * 2 ** Math.min(failures++, 2));
    } finally {
      pending = false;
      if (current() && !document.hidden && delay !== null) timer = setTimeout(() => void fetchPage(), delay);
    }
  }
  function visibilityChanged() {
    clearTimeout(timer);
    if (!document.hidden) void fetchPage();
  }
  document.addEventListener('visibilitychange', visibilityChanged);
  void fetchPage();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
}
