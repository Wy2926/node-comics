/** Real directory UI, synthetic import failure, no external requests or user data. */
import {Profiler, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ComicSites} from '../src/ui/ComicSites';
import {emptySiteFilters} from '../src/ui/SiteFilterControls';
import {Scrollbars} from '../src/ui/Scrollbars';
import {useUiLocale} from '../src/i18n/react';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';
import german from '../src/i18n/dictionaries/de.json';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';
import '../src/ui/phone.css';

if (location.origin !== 'http://127.0.0.1:5205') throw Error('Use the isolated http://127.0.0.1:5205 fixture.');
globalThis.fetch = async () => {throw Error('Fixture: network requests disabled');};
const options = new URLSearchParams(location.search), profiling = options.has('performance');
const locale = options.get('locale');
installDictionary(locale === 'de' ? 'de' : locale === 'en' ? 'en' : 'zh-CN', locale === 'de' ? german : locale === 'en' ? english : {});
document.documentElement.dataset.appearance = options.get('appearance') === 'dark' ? 'dark' : 'light';
let commits = 0, renderMs = 0, dateFormatters = 0;
if (profiling) Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
  construct(target, args) {dateFormatters++; return Reflect.construct(target, args);},
});
const snapshot = () => ({commits, renderMs: Number(renderMs.toFixed(2)), dateFormatters, cards: document.querySelectorAll('.nc-site-card').length, scrollTop: window.scrollY});
for (const id of ['metrics', 'reset-metrics']) document.getElementById(id)!.hidden = !profiling;
document.getElementById('reset-metrics')!.onclick = () => {commits = renderMs = dateFormatters = 0;};
if (profiling) setInterval(() => {document.getElementById('metrics')!.textContent = JSON.stringify(snapshot());}, 250);
Object.assign(window, {siteDirectoryMetrics: {snapshot}});
const onImport = async () => {throw Error('隔离测试：目录读取失败，请重试。');};
function Fixture() {
  useUiLocale();
  useEffect(() => {
    if (options.has('brokenIcon')) document.querySelector('.nc-site-monogram img')?.setAttribute('src', '/fixture-missing-icon.svg');
  }, []);
  const [open, setOpen] = useState(true);
  const view = useRef({filters: emptySiteFilters, query: '', advanced: false, scrollTop: 0});
  const directoryProps = {view, onImport};
  return <div className="nc-app"><Scrollbars/>
    <header className="nc-app-header" style={{flexWrap: 'wrap', gap: 8}}><button className="button secondary" onClick={() => {location.hash = 'sites'; setOpen(true);}}>网站目录</button>
      <button className="button secondary" onClick={() => {location.hash = 'library'; setOpen(false);}}>暂时离开</button>
      <button className="button secondary" onClick={() => installDictionary('en', english)}>English</button>
      <button className="button secondary" onClick={() => installDictionary('zh-CN', {})}>简体中文</button>
      <button className="button secondary" onClick={() => {document.documentElement.dataset.appearance = document.documentElement.dataset.appearance === 'dark' ? 'light' : 'dark';}}>切换亮暗</button>
    </header>
    <main className="nc-main" style={{paddingBottom: 100}}>{open ? <Profiler id="sites" onRender={(_id, _phase, duration) => {if (profiling) {commits++; renderMs += duration;}}}><ComicSites {...directoryProps}/></Profiler> : <p>目录已卸载，返回应保留筛选与滚动位置。</p>}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
