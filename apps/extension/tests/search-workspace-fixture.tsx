/** Real search UI, synthetic failures and no external network or model calls. */
import {Profiler, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ApiError, type Api} from '../src/api';
import {listSearchSites} from '../src/sources';
import {ComicSearchPanel} from '../src/ui/comic-search/ComicSearchPanel';
import {Scrollbars} from '../src/ui/Scrollbars';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
import '../src/ui/phone.css';

if (location.origin !== 'http://127.0.0.1:5206') throw Error('Use the isolated http://127.0.0.1:5206 fixture.');
installDictionary('zh-CN', {});
globalThis.fetch = async () => {throw Error('Fixture: network requests disabled');};
localStorage.setItem('nc-search-sites', JSON.stringify(Object.fromEntries(listSearchSites().map((site, index) => [site.key, index < 2]))));
let commits = 0, renderMs = 0, titleCalls = 0, sample: ReturnType<typeof setTimeout> | undefined;
const report = (label: string) => {document.getElementById('metrics')!.textContent = JSON.stringify({label, commits, renderMs: Number(renderMs.toFixed(2)), titleCalls});};
const api = {translateComicTitle: async () => {titleCalls++; throw new ApiError('Fixture: retry in five seconds', 'RATE_LIMITED', 429, undefined, 5);}} as unknown as Api;
function Fixture() {
  const [open, setOpen] = useState(true), [locale, setLocale] = useState(false);
  return <div className="nc-app"><Scrollbars/>
    <header className="nc-app-header" style={{flexWrap: 'wrap', gap: 8}}>
      <button className="button secondary" onClick={() => {if (sample) clearTimeout(sample); commits = renderMs = 0; report('sampling'); sample = setTimeout(() => report('10 seconds'), 10_000);}}>采样 10 秒</button>
      <button className="button secondary" onClick={() => setOpen(value => !value)}>{open ? '暂时离开' : '返回搜索'}</button>
      <button className="button secondary" onClick={() => {installDictionary(locale ? 'zh-CN' : 'en', locale ? {} : english); setLocale(value => !value);}}>中 / EN</button>
      <button className="button secondary" onClick={() => {document.documentElement.dataset.appearance = document.documentElement.dataset.appearance === 'dark' ? 'light' : 'dark';}}>亮 / 暗</button>
    </header>
    <main className="nc-main"><Profiler id="search" onRender={(_id, _phase, duration) => {commits++; renderMs += duration;}}>
      <ComicSearchPanel open={open} presentation="page" seed={{title: ''}} api={api} defaultLanguage="en" onImportHit={async () => {throw Error('Fixture: import disabled');}}/>
    </Profiler></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
