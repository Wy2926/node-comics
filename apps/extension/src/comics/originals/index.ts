import { catalog } from '../repositories';
import { hashFile } from '../../importers/hash';

type Replica={id:string;origin:string;userId:string;imageSha256:string;assetId:string;expiresAt?:string|null;[key:string]:unknown};
let account:{origin:string;userId:string;download:(assetId:string)=>Promise<Blob>;isCurrent:()=>boolean}|undefined;
export function authorizeOriginals(value:typeof account){account=value;}
export async function registerOriginal(origin:string,userId:string,imageSha256:string,assetId:string,expiresAt?:string|null){
  const id='original:'+JSON.stringify([origin,userId,imageSha256]);
  await catalog.put('metadata',{id,origin,userId,imageSha256,assetId,expiresAt});
}
export async function originalReplica(imageSha256:string):Promise<Blob|undefined>{
  const session=account;if(!session?.isCurrent())return;
  const record=await catalog.get('metadata','original:'+JSON.stringify([session.origin,session.userId,imageSha256])) as Replica|undefined;
  if(!record||record.expiresAt&&Date.parse(record.expiresAt)<=Date.now())return;
  const blob=await session.download(record.assetId);
  if(!session.isCurrent()||account!==session)throw Error('Account changed');
  if(await hashFile(blob)!==imageSha256)throw Error('Original replica content changed');
  return blob;
}
