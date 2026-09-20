import {vi} from 'vitest';
import {API_ORIGIN} from '../src/service';
import type {Session} from '../src/auth/model';

export function testSession(changes:Partial<Session>={}):Session{
  return {id:'test-session',token:'test-token',expiresAt:Date.now()+3600000,refreshAt:Date.now()+3540000,user:{id:'reader',name:'Reader',role:'reader'},apiOrigin:API_ORIGIN,credential:{kind:'development'},...changes};
}
export function stubAuthLocks(){
  const queues=new Map<string,Promise<unknown>>();
  vi.stubGlobal('navigator',{locks:{request:(key:string,run:()=>Promise<unknown>)=>{
    const result=(queues.get(key)??Promise.resolve()).then(run);
    queues.set(key,result.catch(()=>{}));return result;
  }}});
}
