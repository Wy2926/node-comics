import {useEffect,useState} from 'react';
import {listChannels,selectChannel,subscribeChannels,type ChannelProfile} from '../translation/channels';
import {msg} from '../i18n/runtime';
import {Select} from './Select';
import './channel-options.css';

export function ChannelPicker(){
  const [profiles,setProfiles]=useState<ChannelProfile[]>([]),[active,setActive]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let live=true;
    const refresh=()=>void listChannels().then(value=>{if(live){setProfiles(value.profiles);setActive(value.activeId);}}).catch(error=>{if(live)setError(error.message);});
    refresh();const stop=subscribeChannels(refresh);
    return()=>{live=false;stop();};
  },[]);
  async function choose(id:string){
    setBusy(true);setError('');
    try{await selectChannel(id);}catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  return <div className="nc-channel-picker">
    <label className="nc-config-row"><span>{msg('翻译渠道')}</span>
      <Select aria-label={msg('翻译渠道')} value={active} disabled={busy||!profiles.length} onChange={event=>void choose(event.target.value)}>
        {profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </Select>
    </label>
    {error&&<p className="error" role="alert">{error}</p>}
  </div>;
}
