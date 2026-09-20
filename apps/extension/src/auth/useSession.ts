import {useEffect,useState} from 'react';
import {readAuth,subscribeAuth} from './storage';
import {sessionAuthorization} from './session';
import type {AuthState} from './model';

export function useSession(){
  const [auth,setAuth]=useState<AuthState>({session:null});
  useEffect(()=>{
    let live=true,revision=0;
    const sync=async()=>{const version=++revision;const value=await readAuth();if(live&&version===revision)setAuth(value);};
    const unsubscribe=subscribeAuth(()=>void sync());void sync();
    return()=>{live=false;unsubscribe();};
  },[]);
  useEffect(()=>{
    const session=auth.session;if(!session)return;
    let live=true,timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      if(!live)return;
      if(!document.hidden){try{await sessionAuthorization(session.id).token();}catch{/* State changes on terminal failure; transient failures retain the session. */}}
      const current=(await readAuth()).session;
      if(!live||current?.id!==session.id)return;
      const next=current.credential.kind==='development'?current.expiresAt:Math.max(current.refreshAt,current.retryAt??0);
      clearTimeout(timer);timer=setTimeout(()=>void tick(),Math.min(2147483647,Math.max(1000,document.hidden?30000:next-Date.now())));
    };
    const wake=()=>{clearTimeout(timer);void tick();};
    void tick();window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    return()=>{live=false;clearTimeout(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
  },[auth.session?.id]);
  return auth;
}
