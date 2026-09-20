import {msg} from '../i18n/runtime';
import {API_ORIGIN} from '../service';
import {validSession,type AuthState,type Session} from './model';

export const authKey='nc-auth';
const localChanges=new EventTarget();
const extensionStorage=()=>typeof chrome!=='undefined'?chrome.storage?.local:undefined;
// Extension pages and the service worker use one trusted-context store. Web
// reader tabs use one origin-local store; tokens are never mirrored between them.
export async function readAuth():Promise<AuthState>{
  const storage=extensionStorage();
  let value:AuthState;
  try{value=storage?(await storage.get(authKey))[authKey]:JSON.parse(localStorage.getItem(authKey)??'null');}catch{return {session:null};}
  if(!value)return {session:null};
  if(value.session===null)return {session:null,...(value.reason==='expired'?{reason:'expired' as const}:{})};
  if(!validSession(value.session)||value.session.apiOrigin!==API_ORIGIN)return {session:null,reason:'expired'};
  return value;
}
async function writeAuth(value:AuthState){
  const storage=extensionStorage();
  if(storage){await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await storage.set({[authKey]:value});}
  else localStorage.setItem(authKey,JSON.stringify(value));
  localChanges.dispatchEvent(new Event('change'));
}
export async function saveSession(session:Session|null){
  if(session&&(!validSession(session)||session.apiOrigin!==API_ORIGIN))throw Error(msg("登录会话或服务地址无效。"));
  await navigator.locks.request('nc-auth-write',()=>writeAuth({session}));
}
// A late refresh or 401 from an old login must never replace the new account.
export async function updateSession(id:string,token:string,change:(session:Session)=>AuthState){
  return navigator.locks.request('nc-auth-write',async()=>{
    const current=await readAuth();
    if(current.session?.id!==id||current.session.token!==token)return false;
    await writeAuth(change(current.session));return true;
  });
}
export async function signOut(id:string){
  await navigator.locks.request('nc-auth-write',async()=>{if((await readAuth()).session?.id===id)await writeAuth({session:null});});
}
export function subscribeAuth(listener:()=>void){
  const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes[authKey])listener();};
  const webChanged=(event:StorageEvent)=>{if(event.key===authKey||event.key===null)listener();};
  localChanges.addEventListener('change',listener);
  if(extensionStorage())chrome.storage.onChanged.addListener(changed);
  else if(typeof window!=='undefined')window.addEventListener('storage',webChanged);
  return ()=>{localChanges.removeEventListener('change',listener);if(extensionStorage())chrome.storage.onChanged.removeListener(changed);else if(typeof window!=='undefined')window.removeEventListener('storage',webChanged);};
}
