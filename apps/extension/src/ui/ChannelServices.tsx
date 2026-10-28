import {useId,useState} from 'react';
import type {ChannelServiceSelection} from '../translation/channels/contracts';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {PickerMenu} from './PickerMenu';
import {ChannelFields} from './ChannelFields';
import {SettingRow} from './components';

export function ChannelServices({services}:{services:ChannelServiceSelection}){
  const id=useId(),[open,setOpen]=useState(false),[editing,setEditing]=useState<string|null|undefined>(),[values,setValues]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const selected=services.items.find(item=>item.id===services.selectedId),original=services.items.find(item=>item.id===editing);
  function toggle(next:boolean){setOpen(next);if(!next){setEditing(undefined);setValues({});setError('');}}
  async function run(action:()=>Promise<void>){
    setBusy(true);setError('');
    try{await action();toggle(false);document.getElementById(id)?.focus({preventScroll:true});}catch(error){setError((error as Error).message);}finally{setBusy(false);}
  }
  function edit(id?:string){setEditing(id??null);setValues(services.items.find(item=>item.id===id)?.values??{});setError('');}
  return <section className="nc-channel-services-panel">
    <SettingRow title={<label htmlFor={id}>{services.label}</label>} description={services.description} descriptionId={id+'-note'}>
      <PickerMenu id={id} label={services.label} descriptionId={id+'-note'} open={open} onOpenChange={toggle} busy={busy} width={420} viewKey={editing===undefined?'list':editing??'new'} trigger={<span>{selected?.label}</span>}>
      {editing===undefined?<div>
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
      </div>:<div className="nc-picker-editor">
      <h4>{editing===null?services.addLabel:msg('编辑供应商')}</h4>
      <form className="nc-service-form" onSubmit={event=>{event.preventDefault();void run(()=>services.save(values,editing??undefined));}}>
        <ChannelFields fields={services.fields.filter(field=>!field.advanced)} values={values} onChange={setValues} disabled={busy} saved={values.baseUrl===original?.values?.baseUrl?original?.savedSecrets:[]}/>
        <details className="nc-config-advanced"><summary>{msg('高级协议设置')}</summary>
          <p className="nc-muted">{msg('一般无需修改。仅在服务要求特定参数时调整。')}</p>
          <ChannelFields fields={services.fields.filter(field=>field.advanced)} values={values} onChange={setValues} disabled={busy}/>
        </details>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="nc-config-actions">
          <button type="button" className="button secondary small" disabled={busy} onClick={()=>{setEditing(undefined);setValues({});setError('');}}>{msg('取消')}</button>
          <button type="submit" className="button primary small" disabled={busy}>{busy?msg('正在保存…'):msg('保存并使用')}</button>
        </div>
      </form>
      </div>}
      </PickerMenu>
    </SettingRow>
  </section>;
}
