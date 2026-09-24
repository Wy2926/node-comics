import icon from './icon.svg?inline';
import installation from './installation.json';
import type {SourceDefinition} from '../../contracts/definition';

export function comixLocation(url:URL) {
  if(url.protocol!=='https:' || url.hostname!=='comix.to' || url.port || url.username || url.password)return null;
  const match=/^\/title\/([a-z0-9]+)(?:-([a-z0-9-]+))?(?:\/(\d+)-chapter-(\d+(?:\.\d+)?))?\/?$/.exec(url.pathname);
  return match?{hid:match[1],slug:match[1]+(match[2]?'-'+match[2]:''),chapterId:match[3],number:match[4]}:null;
}
export const definition:SourceDefinition={
  id:'comix',name:'Comix',
  sites:[{id:'comix',name:'Comix',url:'https://comix.to/',icon:icon}],
  capabilities:{importable:true,pages:true,inline:true,catalog:true,completePageList:true},
  catalogSync:{intervalMinutes:720},
  installation,
  identify(url){
    if(url.hostname!=='comix.to')return null;
    const loc=comixLocation(url);
    if(!loc)return {sourceId:this.id,pageKey:this.id+':'+url.href,kind:'other',url:url.href};
    const key='comix:'+loc.hid;
    return {sourceId:this.id,pageKey:key+(loc.chapterId?':chapter:'+Number(loc.number):''),
      kind:loc.chapterId?'reader':'catalog',url:url.href,
      catalog:{key,url:'https://comix.to/title/'+loc.slug}};
  },
};
