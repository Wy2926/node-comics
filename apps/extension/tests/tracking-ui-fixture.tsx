/** Deterministic presentation fixture. All tracker operations are local mocks, never real OAuth or AniList writes. */
import {useCallback, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Api} from '../src/api';
import {defaults, type ReadingEntry, type Settings} from '../src/types';
import {Reader} from '../src/reader/Reader';
import {sourcePageCache} from '../src/storage/source-pages';
import {TrackingSettings} from '../src/ui/tracking/TrackingSettings';
import {trackingClient, type TrackingView} from '../src/tracking/client';
import {installDictionary} from '../src/i18n/runtime';
import english from '../src/i18n/dictionaries/en.json';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if (location.origin !== 'http://127.0.0.1:5181') throw Error('Use the isolated http://127.0.0.1:5181 fixture origin.');
const listeners = new Set<() => void>(), calls: {command: string; mediaId?: number; offset?: number}[] = [];
const state: TrackingView = {configured: true, redirectUrl: 'https://fixture.chromiumapp.org/anilist', enabled: false, suggestedMediaId: 123};
let failNext: string | undefined, holdSearch = false, releaseSearch: (() => void) | undefined, holdConnect = false, releaseConnect: (() => void) | undefined, authRevision = 0;
let holdStatus = false;
const pendingStatus: (() => void)[] = [];
let authorization: {revision: number; enabled: boolean} | undefined;
const emit = () => { for (const listener of listeners) listener(); };
async function mutate(command: string, update: () => void) {
  calls.push({command});
  await new Promise(resolve => setTimeout(resolve, 40));
  if (failNext) { const reason = failNext; failNext = undefined; throw Error(reason); }
  update(); emit();
}
trackingClient.status = async () => {
  const view = structuredClone(state);
  if (holdStatus) await new Promise<void>(resolve => { pendingStatus.push(resolve); });
  return view;
};
trackingClient.subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
trackingClient.connect = async () => {
  const attempt = {revision: ++authRevision, enabled: state.enabled}; authorization = attempt;
  state.enabled = false; emit();
  if (holdConnect) await new Promise<void>(resolve => { releaseConnect = resolve; });
  if (attempt.revision !== authRevision) throw Error('cancelled');
  try {
    await mutate('connect', () => { if (attempt.revision === authRevision) { state.account = {id: 7, name: 'Local fixture reader'}; state.enabled = attempt.enabled; authorization = undefined; } });
  } catch (error) {
    if (attempt.revision === authRevision) { state.enabled = attempt.enabled; authorization = undefined; emit(); }
    throw error;
  }
};
trackingClient.disconnect = () => { authRevision++; authorization = undefined; return mutate('disconnect', () => { delete state.account; delete state.binding; delete state.job; state.enabled = false; }); };
trackingClient.setEnabled = enabled => mutate('enable', () => { state.enabled = enabled; if (authorization) authorization.enabled = enabled; });
trackingClient.search = async query => {
  calls.push({command: `search:${query}`});
  if (holdSearch) await new Promise<void>(resolve => { releaseSearch = resolve; });
  return query === '123' ? [{id: 123, title: 'Paper Stars · original manga', chapters: 40}] : [
    {id: 123, title: 'Paper Stars · original manga', chapters: 40},
    {id: 124, title: 'Paper Stars · sequel', chapters: null},
  ];
};
trackingClient.bind = (_, mediaId, offset) => mutate('bind', () => { calls.push({command: 'binding', mediaId, offset}); state.binding = {mediaId, title: mediaId === 123 ? 'Paper Stars · original manga' : 'Paper Stars · sequel', offset, paused: false}; delete state.job; });
trackingClient.unbind = () => mutate('unbind', () => { delete state.binding; delete state.job; });
trackingClient.pause = (_, paused) => mutate('pause', () => { if (state.binding) state.binding.paused = paused; });
trackingClient.retry = () => mutate('retry', () => { if (state.job) { state.job.status = 'synced'; delete state.job.reason; } });
trackingClient.resetBaseline = () => mutate('reset-baseline', () => { delete state.job; });
const fixture = {
  snapshot: () => structuredClone({state, calls, listeners: listeners.size}),
  failNext: (reason = 'unavailable') => { failNext = reason; },
  holdStatus: () => { holdStatus = true; },
  releaseStatus: () => { holdStatus = false; for (const resolve of pendingStatus.splice(0)) resolve(); },
  complete: (status: NonNullable<TrackingView['job']>['status'] = 'synced', reason?: string) => { state.job = {status, progress: 12, reason}; emit(); },
  configure: (configured: boolean) => { state.configured = configured; emit(); },
  switchAccount: () => { state.account = {id: 8, name: 'Other local fixture reader'}; delete state.binding; delete state.job; emit(); },
  holdSearch: () => { holdSearch = true; },
  releaseSearch: () => { holdSearch = false; releaseSearch?.(); releaseSearch = undefined; },
  holdConnect: () => { holdConnect = true; },
  releaseConnect: () => { holdConnect = false; releaseConnect?.(); releaseConnect = undefined; },
};
declare global { interface Window { trackingUiFixture: typeof fixture } }
window.trackingUiFixture = fixture;
const canvas = new OffscreenCanvas(480, 720), context = canvas.getContext('2d')!;
context.fillStyle = '#eaf3ff'; context.fillRect(0, 0, 480, 720); context.fillStyle = '#1769b3'; context.fillRect(30, 30, 420, 380);
context.fillStyle = '#fff'; context.font = 'bold 34px sans-serif'; context.fillText('PAPER STARS', 80, 180); context.font = '22px sans-serif'; context.fillText('Local synthetic page', 95, 230);
await sourcePageCache.put('inline-original:tracking-ui-fixture', await canvas.convertToBlob({type: 'image/png'}));
canvas.width = canvas.height = 1;
const initial: ReadingEntry = {
  id: 'tracking-ui-chapter', comicId: 'tracking-ui-comic', title: 'Paper Stars · chapter 12', source: 'fixture', sourceKey: 'tracking-ui-source', generation: 1,
  createdAt: 0, updatedAt: 0, discoveryComplete: true, pageId: 'tracking-page-0', relativeOffset: 0,
  pages: Array.from({length: 12}, (_, index) => ({id: `tracking-page-${index}`, name: `Page ${index + 1}`, width: 480, height: 720, blobKey: 'inline-original:tracking-ui-fixture', jobs: [], outputBlobs: {}})),
};
const api = new Api(location.origin + '/fixture-disabled');
function Fixture() {
  const [surface, setSurface] = useState<'settings' | 'reader'>('settings'), [copy, update] = useState(initial);
  const [settings, setSettings] = useState<Settings>({...defaults, layout: 'continuous'}), [locale, setLocale] = useState('zh-CN'), [dark, setDark] = useState(false);
  const noop = useCallback(() => {}, []), mark = useCallback(async () => {}, []);
  function language() { const next = locale === 'en' ? 'zh-CN' : 'en'; installDictionary(next, next === 'en' ? english : {}); setLocale(next); }
  return <div className="nc-app" style={{height: '100dvh', minHeight: 0, display: 'flex', flexDirection: 'column'}}>
    <header style={{padding: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: 'var(--surface)', borderBottom: '1px solid var(--line)'}}>
      <strong>Local tracking fixture</strong>
      <button data-testid="settings" onClick={() => setSurface('settings')}>Account settings</button>
      <button data-testid="reader" onClick={() => setSurface('reader')}>Reader</button>
      <button data-testid="locale" onClick={language}>{locale}</button>
      <button data-testid="theme" onClick={() => { document.documentElement.dataset.appearance = dark ? 'light' : 'dark'; setDark(!dark); }}>Theme</button>
    </header>
    {surface === 'settings' ? <main className="nc-preferences" style={{width: '100%', maxWidth: 1000, padding: 24, overflowY: 'auto'}}><TrackingSettings/></main>
      : <Reader viewKey="tracking-ui-fixture" copy={copy} sequence={[copy]} settings={settings} setSettings={setSettings} update={update}
        onActiveEntry={noop} onLoadEntry={noop} onMarkRead={mark} onNavigate={noop} onBack={() => setSurface('settings')} onOpenShortcuts={noop}
        onRetry={noop} onUpgrade={noop} onLogin={noop} translationState={() => undefined} onImport={noop} notify={noop} onReadingWindow={noop} api={api} busy={false}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
