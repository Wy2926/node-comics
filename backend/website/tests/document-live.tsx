import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TranslationWorkbench from '../src/components/TranslationWorkbench';
import { translationCopy } from '../src/i18n/translate';
import { workbenchCopy } from '../src/i18n/workbench';
import { languageNames, locales, type Locale } from '../src/i18n/locales';
import { ApiError, checkLocalApi, liveAccounts, localAccountName, loginAs, requireLiveOrigin, signOut, subscribeAuth } from './document-live-auth';
import '../src/styles/global.css';
import '../src/styles/controls.css';
import '../src/styles/public-site.css';
import '../src/styles/marketing.css';
import '../src/styles/rtl.css';
import './document-live.css';

requireLiveOrigin();
const params = new URLSearchParams(location.search);
const selected = params.get('locale') as Locale;
const initialLocale = locales.includes(selected) ? selected : 'zh-CN';

function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale), [dark, setDark] = useState(params.get('theme') !== 'light');
  const [account, setAccount] = useState(localAccountName), [busy, setBusy] = useState(false);
  const [apiState, setApiState] = useState('尚未检查本地 API'), [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  async function check() {
    setChecking(true);
    try { await checkLocalApi(); setApiState('已连接本地开发 API（4324）；计算节点状态以任务实际进度为准。'); }
    catch (error) { setApiState(error instanceof ApiError ? error.message : '本地 API 未启动或无法访问。请先启动 127.0.0.1:4324，再重新检查。'); }
    finally { setChecking(false); }
  }
  useEffect(() => { void check(); return subscribeAuth(() => setAccount(localAccountName())); }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    document.body.dataset.siteTheme = dark ? 'midnight' : 'paper';
    const query = new URLSearchParams(location.search);
    query.set('locale', locale); query.set('theme', dark ? 'dark' : 'light');
    history.replaceState(null, '', location.pathname + '?' + query);
  }, [locale, dark]);
  async function authenticate(username?: string) {
    setBusy(true); setError('');
    try { if (username) await loginAs(username); else await signOut(); }
    catch (error) { setError(error instanceof ApiError ? error.message : '本地登录请求未完成，请检查 API 连接后重试。'); }
    finally { setBusy(false); }
  }
  return <main>
    <header className="document-live-panel" lang="zh-CN" dir="ltr">
      <p className="document-kicker">仅本机 · 真实服务联调</p><h1>整本文件翻译测试入口</h1>
      <p className="document-live-cost"><strong>R2 存储、传输与 LLM 请求都是真实调用，可能产生费用。</strong> 仅上传你有权处理的文件；此入口不会生成假文件、假任务或假译图。</p>
      <p>付费资格和初始额度由隔离启动器在本地数据库预置，不代表真实购买。界面的可用模型、额度、任务和下载均读取本地 API 的实际数据。</p>
      <p>上传封存完成后可以离开。尚未接入测试 GPU 时任务会正常排队，不会伪造完成；原有取消、预占、失败和恢复规则保持不变。</p>
      <p>浏览器直接向 R2 上传。桶 CORS 必须允许 <code>http://127.0.0.1:5195</code> 的 PUT；本入口不代理文件、不修改桶配置。</p>
      <div className="document-live-controls">
        <label>工作台语言<select value={locale} onChange={event => setLocale(event.target.value as Locale)}>{locales.map(item => <option key={item} value={item}>{languageNames[item]}</option>)}</select></label>
        <label>外观<select value={dark ? 'dark' : 'light'} onChange={event => setDark(event.target.value === 'dark')}><option value="dark">深色</option><option value="light">浅色</option></select></label>
      </div>
      <section className="document-live-login" aria-label="本地测试登录">
        <p role="status">{checking ? '正在检查本地 API…' : apiState}</p>
        <p>当前账户：<strong>{account || '未登录'}</strong>。测试 JWT 仅保存在当前标签页会话中，关闭标签页后需要重新登录。</p>
        <div className="document-live-actions">
          {liveAccounts.map((name, index) => <button key={name} className="button" disabled={busy || name === account} onClick={() => { void authenticate(name); }}>{index === 0 ? '登录本地付费账户' : '登录另一测试账户'}</button>)}
          <button className="button secondary" disabled={busy || !account} onClick={() => { void authenticate(); }}>退出测试账户</button>
          <button className="button secondary" disabled={checking} onClick={() => { void check(); }}>重新检查 API</button>
        </div>
        {error && <p className="document-error" role="alert">{error}</p>}
      </section>
    </header>
    <TranslationWorkbench locale={locale} copy={translationCopy[locale]} workbench={workbenchCopy[locale]}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
