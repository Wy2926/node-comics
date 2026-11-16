import {msg} from '../../i18n/runtime';
import {decodeBlobChunk, IMAGE_CHUNK_BYTES, serveImage} from '../../inline/blob-transfer';
import type {sourceDocument} from '../page';

export const SOURCE_FILE_PORT = 'NC_SOURCE_FILE';
export interface SourceFileInfo {id: string; name: string; size: number;}
interface FileTicket extends SourceFileInfo {tabId: number; navigationId: string; url: string;}
type Current = ReturnType<ReturnType<typeof sourceDocument>['current']>;
const expired = () => Error(msg('来源清单已失效，请重新发现。'));
export function validateFileInfo(value: SourceFileInfo): SourceFileInfo {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 256 ||
      typeof value.name !== 'string' || !value.name || value.name.length > 256 ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 512 * 1024 * 1024) throw expired();
  return {id: value.id, name: value.name, size: value.size};
}
export async function sourceFileInfo(page: Current) {
  const opened = await page.session.openFile?.();
  page.controller.signal.throwIfAborted();
  if (!opened) throw expired();
  return {...validateFileInfo({id: opened.id, name: opened.file.name, size: opened.file.size}), navigationId: page.navigationId, url: page.url};
}
export async function registerSourceFile(tabId: number) {
  const value = await chrome.tabs.sendMessage(tabId, {type: 'NC_FILE_INFO'}, {frameId: 0});
  if (value?.error) throw Error(value.error);
  const info = validateFileInfo(value), tab = await chrome.tabs.get(tabId);
  if (value.url !== tab.url || typeof value.navigationId !== 'string' || !value.navigationId) throw expired();
  const id = crypto.randomUUID();
  await chrome.storage.session.set({['nc-file:' + id]: {...info, tabId, url: value.url, navigationId: value.navigationId}});
  return {kind: 'file' as const, id};
}
export function serveSourceFile(port: chrome.runtime.Port, current: () => Current) {
  return serveImage(port, async (request, signal) => {
    const expected = request as FileTicket, page = current();
    validateFileInfo(expected);
    const active = () => !signal.aborted && !page.controller.signal.aborted && current() === page &&
      expected.navigationId === page.navigationId && expected.url === page.url;
    if (!active()) throw expired();
    const opened = await page.session.openFile?.();
    if (!active() || !opened || opened.id !== expected.id || opened.file.size !== expected.size || opened.file.name !== expected.name) throw expired();
    // This immutable file snapshot belongs to the selected book even if the source opens another book later.
    return {blob: opened.file, current: active};
  });
}

/** Only one acknowledged slice is in flight; storage backpressure controls the next read. */
function fileStream(ticket: FileTicket) {
  let port: chrome.runtime.Port, offset = 0, opened = false, closed = false;
  let pending: {resolve(): void; reject(error: unknown): void} | undefined;
  let requestPull: () => void;
  let message: (value: any) => void, disconnected: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer);
    port.onMessage.removeListener(message); port.onDisconnect.removeListener(disconnected);
    try {port.disconnect();} catch { /* The source tab already closed. */ }
  };
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      port = chrome.tabs.connect(ticket.tabId, {name: SOURCE_FILE_PORT, frameId: 0});
      const fail = (error: unknown) => {
        if (closed) return;
        close(); pending?.reject(error); pending = undefined; controller.error(error);
      };
      requestPull = () => {
        clearTimeout(timer); timer = setTimeout(() => fail(expired()), 30000);
        port.postMessage({type: 'pull', offset});
      };
      disconnected = () => {void chrome.runtime.lastError; fail(expired());};
      message = value => {
        if (closed) return;
        try {
          if (value?.type === 'error') throw Error(typeof value.message === 'string' ? value.message : expired().message);
          if (!opened) {
            if (value?.type !== 'image' || value.size !== ticket.size) throw expired();
            opened = true; clearTimeout(timer);
            if (pending) requestPull();
            return;
          }
          if (!pending || value?.type !== 'chunk' || value.offset !== offset) throw expired();
          const bytes = decodeBlobChunk(value.data, Math.min(IMAGE_CHUNK_BYTES, ticket.size - offset));
          clearTimeout(timer); offset += bytes.length; controller.enqueue(bytes);
          pending.resolve(); pending = undefined;
          if (offset === ticket.size) {close(); controller.close();}
        } catch (error) {fail(error);}
      };
      port.onDisconnect.addListener(disconnected); port.onMessage.addListener(message);
      timer = setTimeout(() => fail(expired()), 30000);
      port.postMessage({type: 'open', request: ticket});
    },
    pull() {return new Promise<void>((resolve, reject) => {pending = {resolve, reject}; if (opened) requestPull();});},
    cancel() {close(); pending?.resolve(); pending = undefined;},
  }, {highWaterMark: 0});
}
export async function consumeSourceFile(id: string) {
  const key = 'nc-file:' + id, data = await chrome.storage.session.get(key), ticket = data[key] as FileTicket;
  await chrome.storage.session.remove(key);
  validateFileInfo(ticket);
  if (!Number.isInteger(ticket.tabId) || ticket.tabId < 0 || typeof ticket.url !== 'string' || typeof ticket.navigationId !== 'string') throw expired();
  return {name: ticket.name, size: ticket.size, stream: () => fileStream(ticket)};
}
