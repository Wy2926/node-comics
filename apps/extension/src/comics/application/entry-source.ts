import {catalog} from '../repositories';
import type {OpenFileSourceContext} from '../sources/contracts';

/** Capture one source generation; document readers and progress share the same access gate. */
export async function entrySource(entryId:string,contentId?:string,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const entry=await catalog.get('entries',entryId);
  const comic=entry&&await catalog.get('comics',entry.comicId);
  const connection=comic&&await catalog.get('connections',comic.source.connectionId);
  signal?.throwIfAborted();
  if(!entry||!comic||!connection||contentId&&entry.contentId!==contentId)throw Error('阅读内容已移除或变化，请重新打开。');
  const available=()=>comic.source.status==='active'&&!['disconnected','revoked'].includes(connection.status);
  if(!available())throw Error('来源访问已断开，请重新连接。');
  const assertCurrent=async()=>{
    signal?.throwIfAborted();
    const [current,owner,access]=await Promise.all([catalog.get('entries',entry.id),catalog.get('comics',comic.id),catalog.get('connections',connection.id)]);
    signal?.throwIfAborted();
    if(!current||current.contentId!==entry.contentId||current.generation!==entry.generation||!owner||owner.source.generation!==comic.source.generation||owner.source.status!=='active'||!access||access.generation!==connection.generation||['disconnected','revoked'].includes(access.status))
      throw new DOMException('来源内容或授权已变化，请重新打开。','AbortError');
  };
  const context:OpenFileSourceContext={connection,source:comic.source,entryId,contentId:entry.contentId,format:entry.format,sourceSnapshot:entry.sourceSnapshot,containerId:entry.containerId,signal};
  return {entry,comic,connection,context,assertCurrent};
}
