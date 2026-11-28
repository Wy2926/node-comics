import {useId,useState} from 'react';
import type {ChannelServiceSelection} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {PickerMenu} from './PickerMenu';
import {ChannelServiceDialog} from './ChannelServiceDialog';
import {SettingRow} from './components';

export function ChannelServices({services,language}:{services:ChannelServiceSelection;language:string}){
  const id=useId(),[open,setOpen]=useState(false),[editing,setEditing]=useState<string|null|undefined>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const selected=services.items.find(item=>item.id===services.selectedId);
  function toggle(next:boolean){setOpen(next);setError('');}
  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');
    try{await action();toggle(false);document.getElementById(id)?.focus({preventScroll:true});}catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  function edit(serviceId?:string){
    // 菜单项会卸载，让模态框关闭时能把焦点还给仍在页面上的入口。
    document.getElementById(id)?.focus({preventScroll:true});toggle(false);setEditing(serviceId??null);
  }
  return <section className="nc-channel-services-panel">
    <SettingRow title={<label htmlFor={id}>{services.label}</label>} description={services.description} descriptionId={id+'-note'}>
      <PickerMenu id={id} label={services.label} descriptionId={id+'-note'} open={open} onOpenChange={toggle} busy={busy} width={420} trigger={<span>{selected?.label}</span>}>
      <div>
        <div className="nc-picker-items">{services.items.map(item=><div key={item.id} className="nc-picker-item" data-selected={item.id===services.selectedId||undefined}>
          <button type="button" className="nc-select-option nc-picker-choice" aria-pressed={item.id===services.selectedId} disabled={busy} onClick={()=>void run(()=>services.select(item.id))}>
            <span><strong>{item.label}</strong>{item.description&&<small>{item.description}</small>}</span>{item.id===services.selectedId&&<Icon name="check" size={16}/>}
          </button>
          {item.values&&<div className="nc-picker-item-actions">
            <button type="button" aria-label={msg('编辑供应商')+' · '+item.label} title={msg('编辑供应商')} disabled={busy} onClick={()=>edit(item.id)}><Icon name="settings" size={16}/></button>
            <button type="button" aria-label={msg('移除供应商')+' · '+item.label} title={msg('移除供应商')} data-danger disabled={busy} onClick={()=>void run(()=>services.remove(item.id))}><Icon name="trash" size={16}/></button>
          </div>}
        </div>)}</div>
        <div className="nc-picker-footer"><button type="button" className="nc-select-option" disabled={busy} onClick={()=>edit()}><Icon name="plus" size={16}/>{services.addLabel}</button></div>
        {error&&<p role="alert">{error}</p>}
      </div>
      </PickerMenu>
    </SettingRow>
    {editing!==undefined&&<ChannelServiceDialog services={services} serviceId={editing??undefined} language={language} onClose={()=>setEditing(undefined)}/>}
  </section>;
}
