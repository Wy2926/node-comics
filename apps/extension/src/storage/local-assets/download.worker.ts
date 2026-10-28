import {downloadAsset,type LocalAsset} from './store';
let controller:AbortController|undefined;
onmessage=({data}:{data:{action:'download'|'pause';asset?:LocalAsset}})=>{
  if(data.action==='pause'){controller?.abort();return;}
  if(controller||!data.asset)return;
  controller=new AbortController();let last=0;
  void downloadAsset(data.asset,controller.signal,()=>{if(Date.now()-last>250){postMessage({type:'changed'});last=Date.now();}})
    .catch(()=>{}).finally(()=>{postMessage({type:'done'});controller=undefined;});
};
