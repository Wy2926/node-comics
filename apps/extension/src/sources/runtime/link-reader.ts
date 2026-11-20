import {msg} from '../../i18n/runtime';
import {resolveSource} from '../core/resolve';
import {definitions} from '../registry/definitions';
import {readNetworkSnapshot} from './network';
import {fetchSourceImage} from './image-fetch';
import {requireHostAccess} from '../../host-permissions';
import {inExtension} from './client';

/** Only the selected reader owns these URLs. Never register its pages or consult a shelf manifest. */
export async function readLinkedChapter(url:string, signal:AbortSignal) {
  if (!inExtension()) throw Error(msg('网站采集需在已安装的浏览器插件中执行。'));
  const {definition,location}=resolveSource(url,definitions);
  if (!definition.linkMatch || location.kind!=='reader') throw Error(msg('来源图片清单不可用。'));
  await requireHostAccess();
  const snapshot=await readNetworkSnapshot(location.url,signal);
  if (!snapshot.discoveryComplete || !snapshot.items.length) throw Error(msg('来源图片清单不可用。'));
  const pages=new Map(snapshot.items.map(({id,width,height,resource})=>{
    if(resource.kind!=='http')throw Error(msg('来源图片清单不可用。'));
    return [id,{width,height,read:async(request:AbortSignal)=>
      (await fetchSourceImage(resource.url,AbortSignal.any([request,signal]),undefined,{pageUrl:location.url})).blob}];
  }));
  return {url:location.url,title:snapshot.title,pages};
}
