import { msg } from '../../i18n/runtime';
import type { SourceCatalog } from '../../comics/application/types';
import type { PageManifest } from '../contracts/source';
import { pollSourceDiscovery } from '../core/discovery';
import {readSourceCatalog} from './catalog-reader';
export const inExtension = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export async function sourceMessage<T>(message: unknown): Promise<T> {
  if (!inExtension()) throw Error(msg('网站采集需在已安装的浏览器插件中执行。'));
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Error(result?.error ?? msg('插件通信失败，请重新打开阅读器。'));
  return result.data as T;
}
export async function discoverEntry(
  catalog: SourceCatalog,
  entryId: string,
  signal: AbortSignal,
  onProgress: (manifest: PageManifest) => Promise<void>,
  assertActive?: () => Promise<void>,
  firstLinksOnly = false,
) {
  signal.throwIfAborted();
  await sourceMessage({ type: 'NC_REGISTER_CATALOG', catalog });
  const { tabId } = await sourceMessage<{ tabId: number }>({
    type: 'NC_OPEN_SOURCE',
    catalogId: catalog.id,
    entryId,
  });
  try {
    return await pollSourceDiscovery(
      () => sourceMessage<PageManifest | null>({ type: 'NC_POLL_SOURCE', tabId }),
      {
        signal,
        onProgress,
        assertActive,
        isComplete: firstLinksOnly ? (manifest) => manifest.items.length > 0 : undefined,
      },
    );
  } finally {
    await sourceMessage({ type: 'NC_CLOSE_SOURCE', tabId }).catch(() => {});
  }
}
export async function discoverCatalog(url: string): Promise<SourceCatalog> {
  if (!inExtension()) throw Error(msg('网站采集需在已安装的浏览器插件中执行。'));
  return readSourceCatalog(url);
}

export async function discoverPage(url:string,signal:AbortSignal,onProgress:(manifest:PageManifest)=>Promise<void>,assertActive?:()=>Promise<void>) {
  signal.throwIfAborted();
  const {tabId}=await sourceMessage<{tabId:number}>({type:'NC_OPEN_PAGE',url});
  try{return await pollSourceDiscovery(()=>sourceMessage<PageManifest|null>({type:'NC_POLL_SOURCE',tabId}),{signal,onProgress,assertActive});}
  finally{await sourceMessage({type:'NC_CLOSE_SOURCE',tabId}).catch(()=>{});}
}
