import {catalog} from '../repositories';
import type {SourceAccessChange, SourceSelection} from '../sources/contracts';
import {closeSourceAccess} from '../sources/runtime';
import {sourcePageCache} from '../../storage/source-pages';
import {sourceRangeCache} from '../../storage/source-ranges';
import {thumbnailCache} from '../../storage/thumbnails';
import {sourceCoverOwner} from './cover-access';
const caches=[sourcePageCache,sourceRangeCache,thumbnailCache];

export async function invalidateSourceAccess({connectionId,itemId}:SourceAccessChange) {
  await closeSourceAccess({connectionId,itemId});
  const ids=await catalog.mutate(['connections','comics','entries'],async tx=>{
    const connection=await tx.get('connections',connectionId);if(!connection)return [];
    if(itemId===undefined&&connection.status!=='disconnected')await tx.put('connections',{...connection,status:'disconnected',generation:connection.generation+1,updatedAt:Date.now()});
    const ids:string[]=[];
    for(const comic of await tx.list('comics',{index:'connectionId',range:connectionId,limit:10000})) {
      if(itemId!==undefined&&comic.source.providerItemId!==itemId)continue;
      const status=itemId!==undefined||comic.source.status==='revoked'?'revoked':'disconnected';
      if(comic.source.status===status)continue;
      await tx.put('comics',{...comic,source:{...comic.source,status,generation:comic.source.generation+1}});
      if(comic.sourceCover)ids.push(sourceCoverOwner(comic.id));
      for(const entry of await tx.list('entries',{index:'comicId',range:comic.id,limit:10000})) {
        await tx.put('entries',{...entry,generation:entry.generation+1,error:itemId===undefined?'来源连接已断开。':'源文件访问已撤销，请重新授权。'});ids.push(entry.id);
      }
    }
    return ids;
  });
  for(const id of ids)await Promise.all(caches.map(cache=>cache.deleteOwner(id,true)));
  if(itemId===undefined)await Promise.all(caches.map(cache=>cache.deleteConnection(connectionId)));
}
export async function restoreSourceSelection(selection:SourceSelection) {
  const ids=await catalog.mutate(['connections','comics','entries'],async tx=>{
    const connection=await tx.get('connections',selection.connection.id);if(!connection)return [];
    if(connection.provider!==selection.connection.provider||connection.accountId!==selection.connection.accountId)throw Error('来源账户身份不匹配。');
    await tx.put('connections',{...connection,displayName:selection.connection.displayName,accountMetadata:selection.connection.accountMetadata,
      status:'connected',generation:connection.generation+(connection.status==='connected'?0:1),updatedAt:Date.now()});
    const selected=new Set(selection.files.map(file=>file.id)),ids:string[]=[];
    for(const comic of await tx.list('comics',{index:'connectionId',range:connection.id,limit:10000})) {
      if(comic.source.status==='active'||comic.source.status==='revoked'&&!selected.has(comic.source.providerItemId))continue;
      await tx.put('comics',{...comic,source:{...comic.source,status:'active',generation:comic.source.generation+1}});
      if(comic.sourceCover)ids.push(sourceCoverOwner(comic.id));
      for(const entry of await tx.list('entries',{index:'comicId',range:comic.id,limit:10000})) {
        await tx.put('entries',{...entry,generation:entry.generation+1,error:undefined});ids.push(entry.id);
      }
    }
    return ids;
  });
  for(const id of ids)await Promise.all(caches.map(cache=>cache.allowOwner(id)));
}
