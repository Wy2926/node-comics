import {msg} from '../i18n/runtime';

export const INLINE_RESULT_PORT = 'NC_INLINE_RESULT';
export const INLINE_SOURCE_PORT = 'NC_INLINE_SOURCE';
export const IMAGE_CHUNK_BYTES = 512 * 1024;
const chunkCharacters = 4 * Math.ceil(IMAGE_CHUNK_BYTES / 3);
const loadTimeout = 120_000, chunkTimeout = 30_000;
const failure = () => Object.assign(Error(msg('翻译文件校验失败，请重新加载。')), {code: 'IMAGE_TRANSFER_FAILED'});
type Listener = (message: any) => void;

function encode(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let at = 0; at < bytes.length; at += 16384)
    parts.push(String.fromCharCode(...bytes.subarray(at, at + 16384)));
  return btoa(parts.join(''));
}
function decode(value: unknown, length: number) {
  if (typeof value !== 'string' || value.length > chunkCharacters || value.length !== 4 * Math.ceil(length / 3)) throw failure();
  const binary = atob(value);
  if (binary.length !== length) throw failure();
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
function disconnect(port: chrome.runtime.Port) { try { port.disconnect(); } catch { /* Already closed. */ } }

/** One acknowledged slice at a time: neither endpoint builds a full-image Base64 string. */
export function receiveImage(port: chrome.runtime.Port, request: unknown, signal?: AbortSignal, current = () => true): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let closed = false, size: number | undefined, mime = '', offset = 0;
    const parts: Blob[] = [];
    let timer: ReturnType<typeof setTimeout>;
    // A connected port alone does not keep an MV3 worker alive while composing.
    const heartbeat = setInterval(() => { try { port.postMessage({type: 'ping'}); } catch { finish(failure()); } }, 15_000);
    const cleanup = () => {
      closed = true; clearTimeout(timer); clearInterval(heartbeat);
      signal?.removeEventListener('abort', aborted);
      port.onMessage.removeListener(message); port.onDisconnect.removeListener(ended);
      disconnect(port); parts.length = 0;
    };
    const finish = (error?: unknown) => {
      if (closed) return;
      const blob = error ? undefined : new Blob(parts, {type: mime});
      cleanup(); if (error) reject(error); else resolve(blob!);
    };
    const arm = (milliseconds: number) => { clearTimeout(timer); timer = setTimeout(() => finish(failure()), milliseconds); };
    const aborted = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const ended = () => { void chrome.runtime.lastError; finish(failure()); };
    const message: Listener = value => {
      if (closed) return;
      try {
        signal?.throwIfAborted(); if (!current()) throw new DOMException('Aborted', 'AbortError');
        if (value?.type === 'error') throw Object.assign(Error(typeof value.message === 'string' ? value.message : failure().message), {code: value.code});
        if (size === undefined) {
          if (value?.type !== 'image' || !Number.isSafeInteger(value.size) || value.size < 1 ||
              typeof value.mime !== 'string' || value.mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mime)) throw failure();
          size = value.size; mime = value.mime;
        } else {
          if (value?.type !== 'chunk' || value.offset !== offset) throw failure();
          const length = Math.min(IMAGE_CHUNK_BYTES, size - offset);
          parts.push(new Blob([decode(value.data, length)])); offset += length;
          if (offset === size) { finish(); return; }
        }
        arm(chunkTimeout); port.postMessage({type: 'pull', offset});
      } catch (error) { finish(error); }
    };
    port.onMessage.addListener(message); port.onDisconnect.addListener(ended);
    signal?.addEventListener('abort', aborted, {once: true}); arm(loadTimeout);
    try {
      signal?.throwIfAborted(); if (!current()) throw new DOMException('Aborted', 'AbortError');
      port.postMessage({type: 'open', request});
    } catch (error) { finish(error); }
  });
}

/** Authorization belongs to the caller and is rechecked before every delivered slice. */
export function serveImage(port: chrome.runtime.Port,
  load: (request: unknown, signal: AbortSignal) => Promise<{blob: Blob; current: () => boolean}>,
  onClose: () => void = () => {}) {
  const controller = new AbortController();
  let started = false, busy = false, closed = false, offset = 0;
  let image: {blob: Blob; current: () => boolean} | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); controller.abort(); image = undefined;
    port.onMessage.removeListener(message); port.onDisconnect.removeListener(ended);
    disconnect(port); onClose();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    const value = error as {message?: string; code?: string};
    try { port.postMessage({type: 'error', message: (value.message ?? failure().message).slice(0, 512), code: value.code}); }
    catch { /* The receiver may have closed while loading or encoding. */ }
    finally { close(); }
  };
  const arm = (milliseconds: number) => { clearTimeout(timer); timer = setTimeout(() => fail(failure()), milliseconds); };
  const ended = () => { void chrome.runtime.lastError; close(); };
  const message: Listener = value => {
    if (closed || value?.type === 'ping') return;
    void (async () => {
      if (value?.type === 'open' && !started) {
        started = true;
        const loaded = await load(value.request, controller.signal);
        if (closed) return;
        if (!loaded.current() || !loaded.blob.size) throw failure();
        image = loaded; arm(chunkTimeout);
        port.postMessage({type: 'image', size: loaded.blob.size, mime: loaded.blob.type || 'application/octet-stream'});
        return;
      }
      if (!image || busy || value?.type !== 'pull' || value.offset !== offset || offset >= image.blob.size || !image.current()) throw failure();
      busy = true;
      const bytes = new Uint8Array(await image.blob.slice(offset, offset + IMAGE_CHUNK_BYTES).arrayBuffer());
      if (closed) return;
      if (!image?.current()) throw failure();
      const part = {type: 'chunk', offset, data: encode(bytes)};
      offset += bytes.length; busy = false; arm(chunkTimeout); port.postMessage(part);
    })().catch(fail);
  };
  port.onMessage.addListener(message); port.onDisconnect.addListener(ended); arm(loadTimeout);
  return close;
}
