import {useEffect,useState} from 'react';
import {openActiveChannel,subscribeChannels,type ChannelConnection} from './index';

export function useTranslationChannel(){
  const [channel,setChannel]=useState<ChannelConnection>();
  const [error,setError]=useState('');
  useEffect(()=>{
    let disposed=false,generation=0,current:ChannelConnection|undefined;
    const refresh=async()=>{
      const stamp=++generation;
      current?.dispose();current=undefined;setChannel(undefined);setError('');
      try{
        const next=await openActiveChannel(()=>!disposed&&stamp===generation);
        if(disposed||stamp!==generation){next.dispose();return;}
        current=next;setChannel(next);
      }catch(error){if(!disposed&&stamp===generation)setError((error as Error).message);}
    };
    const reconnect=()=>{if(!current)void refresh();};
    const unsubscribe=subscribeChannels(()=>void refresh());void refresh();
    window.addEventListener('online',reconnect);window.addEventListener('focus',reconnect);
    return ()=>{disposed=true;generation++;unsubscribe();current?.dispose();window.removeEventListener('online',reconnect);window.removeEventListener('focus',reconnect);};
  },[]);
  return {channel,error};
}
