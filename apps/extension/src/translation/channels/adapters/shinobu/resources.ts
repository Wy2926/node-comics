import manifest from '../../../../../third_party/shinobu/packages/model-manifest/manifest.json';
import {assetRecord,type LocalAsset} from '../../../../storage/local-assets/store';
import {fullFont,localFonts} from '../../../font-resources';
import {localHostRequest} from '../../host-client';
import type {ChannelResources,FontDownload,FontDownloads} from '../../contracts';
import {msg} from '../../../../i18n/runtime';
import {translationFontName,defaultTranslationFont} from '../../../../../../../backend/shared/translation-fonts';
const resourceError=(code:string)=>code==='ASSET_BUSY'?msg('资源正在使用，请停止任务或稍后再试。'):code==='ASSET_STORAGE_FULL'?msg('空间不足'):code==='ASSET_CORRUPT'?msg('资源校验失败，请重新下载。'):msg('资源操作失败；请检查空间、网络或正在运行的任务。');
const source='https://github.com/DonutShinobu/ShinobuTranslator/releases/download/models-v0.8.3/';
const modelLicenses:Record<string,string>={detector:'GPL-3.0',inpaint:'GPL-3.0',bubble:'Apache-2.0 / AGPL-3.0','paddleocr-v6-medium':'Apache-2.0','paddleocr-v6-dictionary':'Apache-2.0'};
export const modelAssets:LocalAsset[]=manifest.assets.map(asset=>({id:asset.id,label:asset.path,url:source+asset.path,bytes:asset.size,sha256:asset.sha256,
  source:'https://github.com/DonutShinobu/ShinobuTranslator/blob/c4239a2c653c68f66283b990f96936234c8d7294/packages/model-manifest/publication-policy.json',
  license:modelLicenses[asset.id]}));
export const resourceAssets=()=>[...modelAssets,...localFonts.map(font=>fullFont(font.id))];
export const resourceEvents='nc-local-assets-changed';
async function readAssetState(asset:LocalAsset):Promise<FontDownload>{
  const saved=await assetRecord(asset),downloading=saved?.state==='downloading'||saved?.state==='verifying';
  const locks=downloading?await navigator.locks.query():undefined;
  const live=locks?.held?.some(lock=>lock.name==='nc-local-asset:'+asset.sha256);
  return {id:asset.id,bytes:asset.bytes,downloaded:saved?.offset??0,state:downloading&&!live?'paused':saved?.state??'missing',detail:saved?.error?resourceError(saved.error):undefined};
}
function subscribeResources(listener:()=>void){const channel=new BroadcastChannel(resourceEvents);channel.onmessage=listener;return()=>channel.close();}
export const fontDownloads:FontDownloads={
  read:()=>Promise.all(localFonts.map(async font=>({...await readAssetState(fullFont(font.id)),id:font.id}))),
  subscribe:subscribeResources,
  async download(id){
    if(!localFonts.some(font=>font.id===id))throw Error('FONT_UNAVAILABLE');
    try{await localHostRequest('shinobu',{action:'download',id:fullFont(id).id});}catch(error){throw Error(resourceError(error instanceof Error?error.message:''));}
  },
};
export function resourceManager(fontIds:string[]=[]):ChannelResources{
  return {
    async read(){
      const recognition={id:'recognition',label:msg('文字识别'),description:msg('找到漫画中的文字，并识别为可翻译的内容。')};
      const painting={id:'painting',label:msg('画面处理'),description:msg('识别气泡、清除原文，让译文自然放回画面。')};
      const fonts={id:'fonts',label:msg('翻译字体'),description:msg('只需下载你选择的字体；这里管理完整字库，字体选择仍在翻译设置中。')};
      const descriptions:Record<string,{label:string;description:string;category:typeof recognition}>={
        detector:{label:msg('文字位置检测'),description:msg('定位页面中的文字区域。'),category:recognition},
        'paddleocr-v6-medium':{label:msg('文字识别引擎'),description:msg('读取文字内容，用于后续翻译。'),category:recognition},
        'paddleocr-v6-dictionary':{label:msg('文字识别字典'),description:msg('帮助识别引擎还原正确的字符。'),category:recognition},
        inpaint:{label:msg('原文清除与背景修复'),description:msg('清除原文并修复底色，为译文腾出位置。'),category:painting},
        bubble:{label:msg('对话气泡识别'),description:msg('判断气泡边界，帮助安排译文位置。'),category:painting},
      };
      const selectedFonts=fontIds.length?fontIds:[defaultTranslationFont('zh-Hans')!.id];
      const assets=[...modelAssets,...localFonts.toSorted((a,b)=>Number(selectedFonts.includes(b.id))-Number(selectedFonts.includes(a.id))).map(font=>fullFont(font.id))];
      return Promise.all(assets.map(async asset=>{
      const font=localFonts.find(font=>'font:'+font.id===asset.id),selected=!!font&&selectedFonts.includes(font.id);
      return {...await readAssetState(asset),...(font?{label:translationFontName(font,'zh-Hans'),description:msg('用于译图中的文字绘制，下载后可离线使用。'),category:fonts}:descriptions[asset.id]),required:!font||selected,selected,license:asset.license,source:asset.source};
    }));},
    subscribe:subscribeResources,
    async stop(){await localHostRequest('shinobu',{action:'stop'});},
    async act(action,id){try{await localHostRequest('shinobu',{action,id,fontIds});}catch(error){throw Error(resourceError(error instanceof Error?error.message:''));}},
  };
}
