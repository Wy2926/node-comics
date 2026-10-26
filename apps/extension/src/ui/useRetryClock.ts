import {useEffect, useReducer} from 'react';

/** Refresh only while a visible retry deadline is pending; idle pages own no timer. */
export function useRetryClock(deadline = 0) {
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return;
    const timer = setInterval(() => {
      refresh();
      if (Date.now() >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  // Read the current time on new errors and reopening, before the first timer tick.
  return Date.now();
}
