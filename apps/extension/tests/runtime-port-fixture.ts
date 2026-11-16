import {vi} from 'vitest';

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {addListener: (fn: (...args: any[]) => void) => listeners.add(fn), removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
    emit: (...args: any[]) => {for (const fn of [...listeners]) fn(...args);}, get size() {return listeners.size;}};
}
export function pair() {
  let closed = false;
  const make = () => ({name: 'fixture', onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn()});
  const client = make(), server = make();
  for (const [a,b] of [[client,server],[server,client]]) {
    a.postMessage.mockImplementation(value => {
      if (closed) throw Error('Port closed');
      // Chrome serializes messages; queued sends precede queued disconnection.
      const copy = JSON.parse(JSON.stringify(value)); queueMicrotask(() => b.onMessage.emit(copy));
    });
    a.disconnect.mockImplementation(() => {if (!closed) {closed = true;queueMicrotask(() => {a.onDisconnect.emit();b.onDisconnect.emit();});}});
  }
  return {client,server,port:client as unknown as chrome.runtime.Port,remote:server as unknown as chrome.runtime.Port};
}
