/** Real EPUB/source/materialization/automatic-reader pipeline; only the paid channel is simulated. */
import {useCallback, useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EpubReader} from '../src/reader/EpubReader';
import {defaults, type Job, type ReadingEntry, type Settings} from '../src/types';
import {useAppearance} from '../src/ui/Appearance';
import {Scrollbars} from '../src/ui/Scrollbars';
import {registerSourceDriver} from '../src/comics/sources/registry';
import {localSourceDriver} from '../src/comics/sources/local/driver';
import {createOpdsProvider} from '../src/comics/sources/opds/provider';
import {connectRemoteLibrary, browseRemoteLibrary, openRemotePublication} from '../src/comics/application/remote-library-service';
import {loadEntry, saveReaderState} from '../src/comics/application/library-service';
import {importLocalFile} from '../src/comics/application/import-service';
import {onMaterialized} from '../src/comics/pages/service';
import {useEffect} from 'react';
import {ReadingProgress, type ReadingProgressStatus} from '../src/comics/application/reading-progress';
import {catalog} from '../src/comics/repositories';
import {useAutomaticTranslation} from '../src/translation/useAutomaticTranslation';
import type {ChannelConnection} from '../src/translation/channels/contracts';
import {saveResultBlob} from '../src/storage/translations/results';
import {pageTranslation} from '../src/reader/presentation';
import type {ReadingTarget} from '../src/translation/automatic';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if (location.hostname !== '127.0.0.1' || location.port !== '5198') throw Error('Use the isolated 127.0.0.1:5198 fixture origin.');
const unregister = registerSourceDriver(createOpdsProvider());
const unregisterLocal = registerSourceDriver(localSourceDriver);
if (import.meta.hot) import.meta.hot.dispose(unregister);
if (import.meta.hot) import.meta.hot.dispose(unregisterLocal);
const failFirst = new URLSearchParams(location.search).has('failure');
const localSample = new URLSearchParams(location.search).get('local');
const marker = 'epub-reader-artwork-fixture' + (localSample ? ':local:' + localSample : failFirst ? '-failure' : '');
let entryId = (await catalog.get('metadata', marker))?.entryId as string | undefined;
if (!entryId && localSample) {
  const response = await fetch('/local.epub');
  if (!response.ok) throw Error('Set NC_EPUB_SAMPLE to an explicitly selected local EPUB.');
  entryId = (await importLocalFile(new File([await response.blob()], 'sample.epub'))).id;
  await catalog.put('metadata', {id: marker, entryId});
}
if (!entryId) {
  const connection = await connectRemoteLibrary('opds', {name: 'Illustrated EPUB fixture', auth: 'anonymous', url: location.origin + '/opds'});
  const publications = await browseRemoteLibrary(connection.id);
  const publication = publications.publications.find(value => value.title === 'EPUB sync-fails')!;
  const opened = await openRemotePublication(connection.id, publication.id);
  if (opened.kind !== 'opened') throw Error('Expected Range reading');
  entryId = opened.entryId;
  await catalog.put('metadata', {id: marker, entryId});
}
const initial = await loadEntry(entryId);
const submitted: string[] = [];
const attempts: string[] = [];
const events: string[] = [];
const failures = new Set<string>();

function mockChannel(account: string, changed: () => void): ChannelConnection {
  const scope = {key: (failFirst ? 'epub-fixture-failure:' : 'epub-fixture:') + account};
  return {
    key: scope.key, scope, label: '本地模拟图片翻译 · 无外部请求', available: true, requiresInternet: false, allowsFeedback: false, isCurrent: () => true,
    capabilities: {modes: [{id: 'classic', label: 'Classic', enabled: true}], languages: [{id: 'zh-Hans', label: '简体中文'}, {id: 'en', label: 'English'}], limits: {max_bytes: 20_000_000, max_pixels: 20_000_000, max_dimension: 10_000, max_translation_ids: 20}, entitlements: null},
    createRuntime(options) {
      const attempted = new Set<string>();
      const errors = new Map<string, string>();
      const submit = async (targets: ReadingTarget[], current = () => true) => {
        events.push('submit:' + targets.length + ':' + current() + ':' + options.isCurrent()); changed();
        for (const target of targets) {
          if (!current() || !options.isCurrent()) return;
          if (attempted.has(target.page.id) || pageTranslation(target.page, target.mode, options.language, scope.key).latest) continue;
          attempted.add(target.page.id);
          if (failFirst && target.page.id.endsWith('image-1.png') && !failures.has(scope.key)) {
            failures.add(scope.key); errors.set(target.page.id, '模拟单图失败，其他图片可以继续翻译。'); options.onChange(); continue;
          }
          attempts.push(target.page.id); changed();
          let lease;
          try {
            lease = await options.readOriginal!({entryId: target.entryId, contentId: target.page.contentId!, pageId: target.page.id, renderProfileId: target.page.renderProfileId!});
          } catch (error) {
            errors.set(target.page.id, (error as Error).message); options.onChange(); continue;
          }
          try {
            if (!current()) return;
            submitted.push(scope.key + ':' + target.page.id); changed();
            const identity = 'identity' in lease ? (lease as {identity: {imageSha256: string}}).identity : undefined;
            const job: Job = {id: scope.key + ':' + options.language + ':' + target.page.id, mode: 'classic', target_language: options.language, status: 'succeeded', phase: 'done', quota_pages: 0, created_at: new Date().toISOString(), version: 1, cache_hit: false, source_image_sha256: identity?.imageSha256, result: {key: target.page.id, recoverable: true}};
            await options.onJobs([job]);
          } finally {lease.release();}
        }
      };
      return {init: async () => {events.push('init'); changed();}, submit, manual: async target => {attempted.delete(target.page.id); errors.delete(target.page.id); await submit([target]);}, wait: async () => false,
        hasPending: false, waitingIds: [], retryDelay: 0, stateFor: (target, _active, error) => errors.has(target.page.id) || error ? {kind: 'error', message: errors.get(target.page.id) ?? error!} : undefined, refresh: async () => {}, dispose() {}};
    },
    async readResult(job) {
      const canvas = new OffscreenCanvas(120, 180), context = canvas.getContext('2d')!;
      context.fillStyle = account === 'A' ? '#c6eadb' : '#ead6f5'; context.fillRect(0, 0, 120, 180);
      context.fillStyle = '#202d43'; context.font = 'bold 14px sans-serif'; context.fillText(job.target_language === 'en' ? 'TRANSLATED' : '中文译图', 8, 65);
      context.font = '12px sans-serif'; context.fillText('Account ' + account, 8, 98); context.fillText(job.result!.key.split('/').at(-1)!, 8, 126);
      return saveResultBlob({scope, job, isCurrent: () => true, blob: await canvas.convertToBlob({type: 'image/png'})});
    },
    dispose() {},
  };
}

function Fixture() {
  const [copy, setCopy] = useState(initial), [settings, setSettings] = useState<Settings>({...defaults, readerBackground: 'paper'});
  const [mounted, setMounted] = useState(true), [account, setAccount] = useState('A');
  const [, render] = useState(0);
  const [status, setStatus] = useState<ReadingProgressStatus>();
  const [window, setWindow] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const progress = useMemo(() => new ReadingProgress(() => {}, setStatus), []);
  const copyRef = useRef(copy); copyRef.current = copy;
  useAppearance(settings);
  const channel = useMemo(() => mockChannel(account, () => render(value => value + 1)), [account]);
  const update = useCallback((next: ReadingEntry) => {copyRef.current = next; setCopy(next); void saveReaderState(next); progress.update(next);}, [progress]);
  const translation = useAutomaticTranslation({channel, copies: [copy], updateEntry: update, language: settings.language, currentId: mounted ? copy.id : undefined});
  const onWindow = useCallback((targets: ReadingTarget[], visible: ReadingTarget['page'][]) => {
    setWindow(previous => JSON.stringify(previous) === JSON.stringify(targets.map(value => value.page.id)) ? previous : targets.map(value => value.page.id));
    translation.onReadingWindow(targets, visible);
  }, [translation.onReadingWindow]);
  useEffect(() => onMaterialized(identity => setCopy(previous => ({...previous, pages: previous.pages.map(page => page.id === identity.pageId ? {...page, imageSha256: identity.imageSha256, width: identity.width, height: identity.height, imageByteSize: identity.byteSize, imageMime: identity.mime} : page)}))), []);
  useEffect(() => {if (mounted) void progress.open(copyRef.current); return () => {void progress.close();};}, [progress, mounted]);
  return <div className="nc-app">
    <Scrollbars/>
    {mounted ? <EpubReader copy={copy} settings={settings} setSettings={setSettings} update={update} viewKey={localSample ? 'epub-local-' + localSample : 'epub-artwork-ui-fixture'}
      progressStatus={status} backLabel="关闭阅读器" backText="书架" onBack={() => setMounted(false)} onOpenShortcuts={() => setNotice('已打开快捷键入口')}
      notify={setNotice} caps={channel.capabilities} channelLabel={channel.label} translationScope={channel.scope.key} onReadingWindow={onWindow}
      translationState={translation.stateFor} onRetry={(page, mode) => translation.retry(copy.id, page, mode)} onLogin={() => {}} onUpgrade={() => {}}/>
      : <button className="button primary" onClick={() => {void loadEntry(copy.id, channel.scope).then(next => {setCopy(next); setMounted(true);});}}>重开阅读器</button>}
    <details style={{position: 'fixed', bottom: 8, left: 104, zIndex: 90, background: 'var(--surface)', padding: 8}}>
      <summary role="button">验收数据（仅本地模拟）</summary>
      <button onClick={() => setAccount(value => value === 'A' ? 'B' : 'A')}>切换模拟账号 {account}</button>
      <output aria-label="翻译窗口">{window.join(' | ') || '无翻译目标'}</output><br/>
      <output aria-label="已提交图片">{submitted.join(' | ') || '尚未提交'}</output><br/>
      <output aria-label="准备图片">{attempts.join(' | ') || '尚未准备'}</output><br/>
      <output aria-label="模拟状态">{events.slice(-12).join(' | ')}</output><br/>
      <output aria-label="图片状态">{JSON.stringify(copy.pages.map(page=>({id:page.id,scope:page.translationScope,jobs:page.jobs.map(job=>({id:job.id,status:job.status,result:job.result})),outputs:Object.keys(page.outputBlobs),error:page.translationError})))}</output><br/>
      <output aria-label="保存位置">{JSON.stringify(copy.documentLocation)}</output><br/>
      <output aria-label="界面提示">{notice}</output>
    </details>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
