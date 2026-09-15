import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { Api } from '../api';
import { fallbackLanguages, type Capabilities, type Settings, type UserQueue } from '../types';
import { normalizeConcurrency } from '../concurrency';
import { normalizeAhead } from '../reader/automatic';
import { Icon } from '../icons';
import { AppearanceSettings } from './Appearance';
import { PageTitle, SettingRow } from './components';
type Props = {
  api: Api;
  account: boolean;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  caps?: Capabilities;
  cacheBytes: number;
  notify: (message: string) => void;
  onClearCache: () => void;
  onSaveApiAddress: (draft: string) => Promise<void>;
};
export function Preferences({ api, account, settings, setSettings, caps, cacheBytes, onClearCache, onSaveApiAddress }: Props) {
  const [apiDraft, setApiDraft] = useState(settings.apiBase);
  useEffect(() => setApiDraft(settings.apiBase), [settings.apiBase]);
  const [queue, setQueue] = useState<UserQueue>();
  const [queueError, setQueueError] = useState('');
  useEffect(() => {
    if (!account)
      return;
    let active = true;
    void api.queue().then(value => {
      if (active && api.isCurrent()) {
        setQueue(value);
        setQueueError('');
      }
    }).catch(e => {
      if (active && api.isCurrent())
        setQueueError((e as Error).message);
    });
    return () => { active = false; };
  }, [api, account]);
  return <>
    <PageTitle eyebrow="MAKE IT YOURS" title="外观与偏好" description="调成你喜欢的阅读节奏，偏好保存在本机。" />
    <AppearanceSettings settings={settings} onChange={setSettings} />
    <section className="settings-card">
      <h3>
        <Icon name="book" />阅读偏好</h3>
      <SettingRow title="默认目标语言" description="切换语言会保留其他语言的译图版本。">
        <select value={settings.language} onChange={e => setSettings(s => ({ ...s, language: e.target.value }))}>{(caps?.languages ?? fallbackLanguages).map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
      </SettingRow>
      <SettingRow title="翻页方向" description="单页模式中的方向键遵循此设置。">
        <select value={settings.direction} onChange={e => setSettings(s => ({ ...s, direction: e.target.value as Settings['direction'] }))}>
          <option value="rtl">从右向左 · 日漫习惯</option>
          <option value="ltr">从左向右</option>
        </select>
      </SettingRow>
      <SettingRow title="阅读方式" description="连续阅读仅解码当前页附近的有限图片窗口。">
        <select value={settings.layout} onChange={e => setSettings(s => ({ ...s, layout: e.target.value as Settings['layout'] }))}>
          <option value="continuous">连续纵向滚动</option>
          <option value="single">单页翻页</option>
        </select>
      </SettingRow>
      <SettingRow title="自动翻译提前页数" description="跟随当前阅读位置，不限制本次总页数；默认提前 10 页，可设 0–50 页。">
        <label className="unit-input">
          <input aria-label="自动翻译提前页数" type="number" min="0" max="50" value={settings.autoAhead} onChange={e => setSettings(s => ({ ...s, autoAhead: normalizeAhead(e.target.value) }))} /> 页 / 向后预译</label>
      </SettingRow>
    </section>
    <section className="settings-card">
      <h3>
        <Icon name="folder" />图片与隐私</h3>
      <SettingRow title="本地图片缓存" description={`当前约 ${(cacheBytes / 1024 / 1024).toFixed(1)} MB；登录后只发送文件标识查找已有翻译；开始翻译时才上传缺失的选定原图。`}>
        <select value={settings.cacheLimitMb} onChange={e => setSettings(s => ({ ...s, cacheLimitMb: Number(e.target.value) }))}>
          <option value="128">128 MB</option>
          <option value="512">512 MB</option>
          <option value="1024">1 GB</option>
        </select>
      </SettingRow>
      <SettingRow title="清理本地图片" description="保留书架与阅读位置；清理后离线无法显示原图。">
        <button className="button danger small" onClick={onClearCache}>清理缓存</button>
      </SettingRow>
      <div className="privacy-note">
        <Icon name="shield" />
        <p>服务器原图与译图暂存 {caps?.retention_days ?? 7} 天。图片归你的账户私有，不接收源网站 Cookie，也不会公开分享。</p>
      </div>
    </section>
    <section className="settings-card">
      <h3>
        <Icon name="globe" />翻译服务</h3>
      <SettingRow title="本机请求并发" description="默认 2，可设 1–10。控制本阅读器的上传、匹配与译图下载等请求，不修改账户的服务器队列并发。">
        <label className="unit-input">
          <input aria-label="本机请求并发" type="number" min="1" max="10" step="1" value={settings.requestConcurrency} onChange={e => setSettings(s => ({ ...s, requestConcurrency: normalizeConcurrency(Number(e.target.value)) }))} /> 个</label>
      </SettingRow>{account && <>
        <SettingRow title="账户翻译队列并发" description={queue ? `套餐上限 ${queue.concurrency}。等待 ${queue.queued} / 已派发 ${queue.dispatched} / 执行中 ${queue.running}。所有设备、批次和翻译模式共享名额。` : '正在读取套餐执行上限；与本机上传、下载并发独立。'}><span>{queue?.concurrency??'—'} 个任务</span></SettingRow>{queueError && <p className="inline-error">队列状态读取失败：{queueError}</p>}</>}<SettingRow title="后端服务地址" description="只填写你的可信产品服务地址。模型与密钥由后端统一管理。">
        <input aria-label="后端服务地址" className="api-input" type="url" value={apiDraft} onChange={e => setApiDraft(e.target.value)} />
        <button className="button secondary small" onClick={() => void onSaveApiAddress(apiDraft)}>保存并连接</button>
      </SettingRow>
      <div className="privacy-note">
        <Icon name="info" />
        <p>当前为本地测试版本。插件如需连接新服务域名，会在使用时申请对应访问权限。</p>
      </div>
    </section>
  </>;
}
