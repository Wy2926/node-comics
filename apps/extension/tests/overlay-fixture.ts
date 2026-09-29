import {hashFile,Sha256} from '../src/importers/hash';
import type {TranslationResult,TranslationSnapshot} from '../src/types';

export const deliveredBytes=new Blob(['image'],{type:'image/webp'});
const sha=new Sha256().update(new TextEncoder().encode('image')).digest();
export const deliveredResult=(id:string):TranslationResult=>({kind:'translated',representation:'full-image-v1',input_sha256:'a'.repeat(64),normalization_version:1,width:800,height:1200,artifact:{sha256:sha,byte_size:deliveredBytes.size,mime:'image/webp',path:`/v1/translations/${id}/result`}});
export const deliveredSnapshot=(id:string):TranslationSnapshot=>({id,state:'succeeded',mode:'redraw',target_language:'zh-Hans',result:deliveredResult(id)});
export async function browserOverlay(){
  const canvas=new OffscreenCanvas(360,120),context=canvas.getContext('2d')!;
  context.fillStyle='#ffffff';context.fillRect(0,0,360,120);
  context.fillStyle='#174bb4';context.font='bold 30px sans-serif';context.fillText('TRANSLATED',20,72);
  const blob=await canvas.convertToBlob({type:'image/webp',quality:1});canvas.width=canvas.height=1;
  const sha256=await hashFile(blob);
  const result=(id:string,input_sha256:string):TranslationResult=>({kind:'translated',representation:'overlay-v1',normalization_version:1,input_sha256,width:640,height:900,bbox:{x:80,y:300,width:360,height:120},composite:'source-atop',artifact:{sha256,byte_size:blob.size,mime:blob.type,path:`/v1/translations/${id}/result`}});
  return {blob,result};
}
