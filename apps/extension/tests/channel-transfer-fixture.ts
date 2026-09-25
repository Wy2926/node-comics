import {vi} from 'vitest';

/** Cross-context exclusive locks with query/ifAvailable, including queued requests. */
export function transferLocks() {
  const tails = new Map<string, Promise<unknown>>(), held = new Set<string>(), pending = new Map<string, number>();
  const request = (name: string, options: unknown, supplied?: (lock: {name: string} | null) => unknown) => {
    const run = (supplied ?? options) as (lock: {name: string} | null) => unknown;
    if (supplied && (options as {ifAvailable?: boolean}).ifAvailable && (held.has(name) || pending.has(name))) return Promise.resolve(run(null));
    pending.set(name, (pending.get(name) ?? 0) + 1);
    const result = (tails.get(name) ?? Promise.resolve()).then(async () => {
      const count = pending.get(name)! - 1;
      if (count) pending.set(name, count); else pending.delete(name);
      held.add(name);
      try {return await run({name});} finally {held.delete(name);}
    });
    tails.set(name, result.catch(() => {}));
    return result;
  };
  const locks = {request, query: async () => ({held: [...held].map(name => ({name})), pending: [...pending.keys()].map(name => ({name}))})};
  vi.stubGlobal('navigator', {locks, onLine: false});
  return locks;
}
export function decodedImage() {vi.stubGlobal('createImageBitmap', vi.fn(async () => ({width: 800, height: 1200, close: vi.fn()})));}
