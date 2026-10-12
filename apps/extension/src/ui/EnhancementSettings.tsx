import {useId, useState} from 'react';
import {msg} from '../i18n/runtime';
import {Icon} from '../icons';
import {Modal, SettingRow} from './components';
import {Select} from './Select';
import {useProcessingSettings} from '../image-processing/react';
import {processingAdapters} from '../image-processing/registry';
import {saveProcessingProfile, updateProcessingSettings} from '../image-processing/settings';
import {clearProcessingCache, removeProcessingProfile} from '../image-processing/storage';
import type {ProcessingProfile} from '../image-processing/contracts';
import './translation-channels.css';

export function EnhancementToggle({configure = false}: {configure?: boolean}) {
  const settings = useProcessingSettings();
  const profile = settings.profiles.find(item => item.id === settings.activeId);
  const [error, setError] = useState('');
  return <div className="nc-reader-option"><div><b>{msg('清晰度优化')}</b><p>{msg('完整译图生成后再增强；关闭翻译时增强原图。')}</p>
    {profile && <p>{msg('当前渠道')} · {profile.name}</p>}
    {configure && <a className="text-link" href="#settings">{profile ? msg('增强渠道') : msg('添加增强渠道')}</a>}
    {error && <p role="alert">{error}</p>}</div>
    <button type="button" className={'switch ' + (settings.enabled ? 'on' : '')} role="switch" aria-label={msg('清晰度优化')}
      aria-checked={settings.enabled} disabled={!profile} onClick={() => {
        setError('');
        void updateProcessingSettings(value => ({...value, enabled: !value.enabled})).catch(error => setError(error.message));
      }}><i/></button></div>;
}

export function EnhancementSettings() {
  const settings = useProcessingSettings(), definitions = processingAdapters(), formId = useId();
  const [editing, setEditing] = useState<ProcessingProfile | null | undefined>();
  const [adapterId, setAdapterId] = useState(definitions[0]?.id ?? '');
  const [name, setName] = useState(''), [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const adapter = definitions.find(item => item.id === adapterId);
  async function action(run: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError('');
    try {await run();} catch (error) {setError((error as Error).message);} finally {setBusy(false);}
  }
  function edit(profile?: ProcessingProfile) {
    setEditing(profile ?? null); setAdapterId(profile?.adapterId ?? definitions[0]?.id ?? '');
    setName(profile?.name ?? ''); setValues(profile?.settings ?? {}); setError('');
  }
  return <section className="settings-card nc-enhancement-settings">
    <div className="nc-channel-heading"><h3><Icon name="image"/>{msg('增强渠道')}</h3>
      <button className="button secondary small" disabled={busy} onClick={() => edit()}>{msg('添加增强渠道')}</button></div>
    <EnhancementToggle/>
    <p className="nc-channel-intro">{msg('图片发送至所选增强服务；插件不运行模型，也不使用翻译额度。')}</p>
    <fieldset className="nc-channel-list" disabled={busy}><legend>{msg('当前渠道')}</legend><div className="nc-channel-grid">
      {settings.profiles.map(profile => <article className="nc-channel-card" key={profile.id} data-selected={settings.activeId === profile.id || undefined}>
        <label className="nc-channel-choice"><input type="radio" name="enhancement-channel" aria-label={profile.name} checked={settings.activeId === profile.id}
          onChange={() => void action(() => updateProcessingSettings(value => ({...value, activeId: profile.id})))}/><span className="nc-channel-identity"><strong>{profile.name}</strong><span className="nc-channel-type">{definitions.find(item => item.id === profile.adapterId)?.label ?? profile.adapterId}</span></span></label>
        <div className="nc-channel-footer"><button className="text-link" onClick={() => edit(profile)}>{msg('编辑')}</button>
          <button className="text-link" onClick={() => void action(() => removeProcessingProfile(profile.id))}>{msg('移除')}</button></div>
      </article>)}
    </div></fieldset>
    <SettingRow title={msg('增强缓存')} description={msg('清理后保留处理记录，再次增强需手动重试。')}>
      <Select aria-label={msg('增强缓存')} value={settings.cacheLimitMb} onChange={event => void action(() => updateProcessingSettings(value => ({...value, cacheLimitMb: Number(event.target.value)})))}>
        {[128, 512, 1024].map(value => <option key={value} value={value}>{value} MB</option>)}
      </Select><button className="button secondary" disabled={busy} onClick={() => void action(clearProcessingCache)}>{msg('清理缓存')}</button>
    </SettingRow>
    {error && editing === undefined && <p className="error" role="alert">{error}</p>}
    {editing !== undefined && <Modal className="nc-channel-dialog" title={msg('增强渠道')} onClose={() => {if (!busy) setEditing(undefined);}} footer={
      <><button className="button secondary" disabled={busy} onClick={() => setEditing(undefined)}>{msg('取消')}</button>
        <button className="button primary" type="submit" form={formId} disabled={busy}>{msg('保存')}</button></>}>
      <form className="nc-channel-form" id={formId} onSubmit={event => {event.preventDefault(); void action(async () => {
        await saveProcessingProfile(adapterId, name, values, editing?.id); setEditing(undefined);
      });}}>
        <label className="field">{msg('服务类型')}<Select value={adapterId} disabled={busy || !!editing} onChange={event => {setAdapterId(event.target.value); setValues({});}}>
          {definitions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select></label>
        <label className="field">{msg('名称')}<input value={name} disabled={busy} placeholder={adapter?.label} maxLength={80} onChange={event => setName(event.target.value)}/></label>
        <label className="field">{msg('服务地址')}<input type="url" required disabled={busy} value={values.url ?? ''} placeholder="http://127.0.0.1:8812/" onChange={event => setValues({...values, url: event.target.value})}/></label>
        {adapter?.fields.map(field => <label className="field" key={field.key}>{field.label}<Select disabled={busy} value={values[field.key] ?? field.defaultValue} onChange={event => setValues({...values, [field.key]: event.target.value})}>
          {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select></label>)}
        <p className="nc-muted">{msg('保存不会发送图片；首次增强时验证服务协议。')}</p>
        {adapter && <a className="text-link" href={adapter.guideUrl} target="_blank" rel="noopener noreferrer">{msg('使用教程')}</a>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </Modal>}
  </section>;
}
