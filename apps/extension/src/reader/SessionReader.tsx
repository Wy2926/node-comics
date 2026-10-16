import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import {bindWebShortcuts} from '../shortcuts/web-content';
import {DECODED_PAGE_WINDOW} from '../image-resources';
import type {Page, ReadingEntry} from '../types';
import {pageFrame} from './geometry';
import {pageAtHeight, pageWindow} from './virtual-window';
import {useChapterStream} from './useChapterStream';
import {useReaderControls} from './useReaderControls';
import {ReaderDrawer, ReaderNavigation, ReaderNumberInput, ReaderSettingsButton, ReaderShell, ReaderTools, isCompactReaderDevice} from './ReaderChrome';
import {ReaderChoice, ReaderDisplaySettings, ReaderScale} from './ReaderOptions';
import {ReaderPicture} from './ReaderPicture';
import {ImageTranslationStatus} from './ImageTranslationStatus';
import {initialReadingView} from './view';
import {sessionAnchor, type SessionReaderPage, type SessionReaderProps, type SessionReaderView} from './session-model';
import layoutStyles from './session-reader.css?raw';
import controlStyles from '../ui/theme/controls.css?raw';
import chromeStyles from './chrome.css?raw';
import progressStyles from './progress.css?raw';
import noticeStyles from './image-notices.css?raw';
import activityStyles from './task-activity.css?raw';
export type {SessionReaderAnchor, SessionReaderPage, SessionReaderProps, SessionReaderImage, SessionReaderView, SessionReaderWindow} from './session-model';
// Only the shared display styles enter the shadow tree, never the app or scrollbar controller.
export const sessionReaderStyles = [layoutStyles, controlStyles, chromeStyles, progressStyles, noticeStyles, activityStyles].join('\n');

const noop = () => {};
const markRead = async () => {};
const sourceSize = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;

function SessionPicture({page, view, active, loadImage, onDimensions}: {
  page: SessionReaderPage;
  view: SessionReaderView;
  active: boolean;
  loadImage: SessionReaderProps['loadImage'];
  onDimensions(width: number, height: number): void;
}) {
  const loader = useRef(loadImage); loader.current = loadImage;
  const acquire = useCallback((_key: string, signal: AbortSignal) => loader.current(page.id, view, signal), [page.id, view]);
  return active ? <ReaderPicture scope={page.id} blobKey={JSON.stringify([page.id, page.revision ?? null, view])}
    acquire={acquire} onDimensions={onDimensions} alt={page.name ?? ''}
    hideSourceActions onImport={noop}/> : null;
}

/** No catalogue, credentials or storage access: the owning document supplies bytes and operations. */
export function SessionReader(props: SessionReaderProps) {
  const {title, pages, settings, setSettings, loadImage, complete = false, notice, onReload, onSelectRegion, onImport} = props;
  const callbacks = useRef(props); callbacks.current = props;
  const [position, setPosition] = useState(() => sessionAnchor(pages, props.initialAnchor));
  const [dimensions, setDimensions] = useState<Record<string, {width: number; height: number}>>({});
  const [view, setView] = useState<SessionReaderView>(props.initialView ?? 'original');
  const [foreground, setForeground] = useState(() => !document.hidden);
  const [viewportSize, setViewportSize] = useState({width: 900, height: 700});
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const firstPage = pages.find(page => page.id === position.pageId) ?? pages[0];
  const [sizing, setSizing] = useState(() => {
    const initial = initialReadingView(firstPage, isCompactReaderDevice());
    return {fit: initial?.fit ?? settings.fit, zoom: initial?.zoom ?? 100};
  });
  const manuallySized = useRef(false), autoSized = useRef(false), exiting = useRef(false);
  const sourceGeometryKey = JSON.stringify(pages.map(page => [page.id, page.name, page.width, page.height]));
  const picturePages = useMemo<Page[]>(() => pages.map(page => ({id: page.id, name: page.name ?? '',
    width: sourceSize(dimensions[page.id]?.width ?? page.width, 900), height: sourceSize(dimensions[page.id]?.height ?? page.height, 1300),
    jobs: [], outputBlobs: {}})), [sourceGeometryKey, dimensions]);
  const copy = useMemo<ReadingEntry>(() => ({id: 'session', title, source: 'website', sourceKey: 'session', generation: 1,
    createdAt: 0, updatedAt: 0, pages: picturePages, pageId: position.pageId, relativeOffset: position.relativeOffset,
    discoveryComplete: complete, knownTotal: complete ? picturePages.length : undefined}), [title, picturePages, position, complete]);
  const sequence = useMemo(() => [copy], [copy]);
  const update = useCallback((entry: ReadingEntry) => {
    const next = {pageId: entry.pageId, relativeOffset: entry.relativeOffset};
    setPosition(previous => previous.pageId === next.pageId && previous.relativeOffset === next.relativeOffset ? previous : next);
    callbacks.current.onPosition?.(next);
  }, []);
  const stream = useChapterStream({copy, sequence, layout: settings.layout, update,
    onActiveEntry: noop, onLoadEntry: noop, onMarkRead: markRead, notify: setMessage});
  const controls = useReaderControls<'directory' | 'settings'>({blocked: false, notify: setMessage, local: true});
  const {root, panel, togglePanel, closePanel, immersive, hidden, reveal, toggleControls, fullscreen} = controls;
  const shortcutState = useRef({exit, panel}); shortcutState.current = {exit, panel};
  useEffect(() => {
    const element = root.current; if (!element) return;
    return bindWebShortcuts({'web.immersive': () => shortcutState.current.exit()}, () => !shortcutState.current.panel, element);
  }, []);
  const {viewport, stacks, geometry, index, indexRef, navigationReason, readingAhead, preserve, persist, restore, jump} = stream;
  const windows = useMemo(() => pageWindow([copy], copy.id, index,
    page => pageFrame(page, viewportSize, sizing.fit, sizing.zoom).height, settings.layout === 'single' ? 1 : DECODED_PAGE_WINDOW),
  [copy, index, viewportSize, sizing, settings.layout]);
  geometry.current = new Map(windows.map(window => [copy.id, window]));
  const currentWindow = windows[0];
  const mountedIds = copy.pages.slice(currentWindow.start, currentWindow.end).map(page => page.id);
  const mountedKey = JSON.stringify(mountedIds);
  const readingIds = foreground ? pages.slice(index, index + readingAhead).map(page => page.id) : [];
  const readingKey = JSON.stringify(readingIds), visibleKey = JSON.stringify(foreground ? visibleIds : []);
  const local = useRef({copy, settings, windows, mountedIds}); local.current = {copy, settings, windows, mountedIds};

  const measureVisible = useCallback(() => {
    const container = viewport.current, stack = stacks.current.get('session'), value = local.current;
    if (!container || !stack || !value.copy.pages.length) {setVisibleIds(previous => previous.length ? [] : previous); return;}
    const metrics = value.windows[0], top = container.getBoundingClientRect().top + container.clientTop - stack.getBoundingClientRect().top;
    const first = value.settings.layout === 'single' ? indexRef.current : pageAtHeight(metrics.offsets, top);
    const ids: string[] = [];
    for (let n = Math.max(0, first); n < value.copy.pages.length; n++) {
      const offset = value.settings.layout === 'single' ? 0 : metrics.offsets[n];
      if (offset >= top + container.clientHeight) break;
      if (value.mountedIds.includes(value.copy.pages[n].id) && offset + metrics.offsets[n + 1] - metrics.offsets[n] > top) ids.push(value.copy.pages[n].id);
      if (value.settings.layout === 'single') break;
    }
    setVisibleIds(previous => previous.length === ids.length && previous.every((id, n) => id === ids[n]) ? previous : ids);
  }, [viewport, stacks, indexRef]);

  useLayoutEffect(() => {
    if (pages.length && !pages.some(page => page.id === stream.anchor.current.pageId)) jump(0);
    restore(); measureVisible();
  }, [picturePages, viewportSize, sizing, settings.layout, mountedKey]);
  useEffect(() => {
    const container = viewport.current; if (!container) return;
    const resize = new ResizeObserver(([entry]) => {
      preserve(); setViewportSize({width: entry.contentRect.width, height: entry.contentRect.height});
    });
    resize.observe(container); return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const change = () => {if (document.hidden) {preserve(); persist();} setForeground(!document.hidden);};
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    callbacks.current.onReadingWindow?.({pageIds: JSON.parse(readingKey), visiblePageIds: JSON.parse(visibleKey), view,
      immediate: navigationReason.current === 'direct'});
  }, [readingKey, visibleKey, view]);
  useEffect(() => () => callbacks.current.onReadingWindow?.({pageIds: [], visiblePageIds: [], view: 'original', immediate: true}), []);
  useEffect(() => {viewport.current?.focus({preventScroll: true});}, []);

  function scroll() {stream.scroll(); measureVisible();}
  function selectView(value: SessionReaderView) {preserve(); setView(value);}
  function resizeView(change: Partial<typeof sizing>) {
    preserve(); manuallySized.current = true;
    setSizing(previous => ({...previous, ...change, ...(change.zoom !== undefined ? {zoom: Math.max(40, Math.min(200, change.zoom))} : {})}));
  }
  function resizeImage(pageId: string, width: number, height: number) {
    if (dimensions[pageId]?.width === width && dimensions[pageId]?.height === height) return;
    preserve(); setDimensions(previous => previous[pageId]?.width === width && previous[pageId]?.height === height
      ? previous : {...previous, [pageId]: {width, height}});
    if (pageId === copy.pages[index]?.id && !autoSized.current && !manuallySized.current) {
      autoSized.current = true;
      const initial = initialReadingView({width, height}, isCompactReaderDevice());
      if (initial) setSizing({fit: initial.fit, zoom: initial.zoom});
    }
  }
  function exit() {
    if (exiting.current) return; exiting.current = true;
    preserve(); persist();
    callbacks.current.onExit(sessionAnchor(pages, stream.anchor.current));
  }
  function selectPage(value: number) {jump(value); closePanel(); viewport.current?.focus({preventScroll: true});}
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    // Source-page shortcuts must not receive typing or navigation inside the reader.
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); if (panel) closePanel(); else exit(); return;}
    const target = event.target as HTMLElement;
    if (event.key === 'Tab') {
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')]
        .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      const active = (event.currentTarget.getRootNode() as ShadowRoot | Document).activeElement;
      if (focusable.length && (event.shiftKey && (active === focusable[0] || !focusable.includes(active as HTMLElement)) || !event.shiftKey && active === focusable.at(-1))) {
        event.preventDefault(); (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
      }
      event.stopPropagation(); return;
    }
    if (target.closest('input,textarea,select,button,a,[contenteditable],[role="group"]')) return;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft': jump(indexRef.current + (settings.direction === 'rtl' ? 1 : -1)); break;
      case 'ArrowRight': jump(indexRef.current + (settings.direction === 'rtl' ? -1 : 1)); break;
      case 'PageUp': jump(indexRef.current - 1); break;
      case 'PageDown': jump(indexRef.current + 1); break;
      case 'ArrowUp': if (settings.layout === 'single') jump(indexRef.current - 1); else handled = false; break;
      case 'ArrowDown': if (settings.layout === 'single') jump(indexRef.current + 1); else handled = false; break;
      case ' ': if (settings.layout === 'single') jump(indexRef.current + (event.shiftKey ? -1 : 1)); else handled = false; break;
      case 'Home': jump(0); break;
      case 'End': jump(pages.length - 1); break;
      case '+': case '=': resizeView({zoom: sizing.zoom + 10}); break;
      case '-': resizeView({zoom: sizing.zoom - 10}); break;
      default: handled = false;
    }
    if (handled) {event.preventDefault(); event.stopPropagation(); reveal();}
  }

  return <div className="nc-app nc-session-reader" role="dialog" aria-modal="true" aria-label={msg('沉浸阅读')} onKeyDown={keyboard}
    data-current-page={pages.length ? index + 1 : 0} data-page-count={pages.length} data-complete={complete} data-view={view}>
    <ReaderShell ref={root} background={settings.readerBackground} immersive={immersive} hidden={hidden} reveal={reveal}>
      <ReaderNavigation backLabel={msg('返回网页')} backText={msg('关闭')} title={title} notice={notice} onBack={exit} showProgress={false}
        directoryOpen={panel === 'directory'} onDirectory={() => togglePanel('directory')}>
        <div className="nc-reader-navigation">
          <button aria-label={msg('上一页')} disabled={!pages.length || index === 0} onClick={() => jump(index - 1)}><Icon name="chevron" style={{transform: 'rotate(-90deg)'}}/></button>
          <label><ReaderNumberInput label={msg('跳转页码')} value={pages.length ? index + 1 : 0} max={pages.length} disabled={!pages.length} onCommit={value => jump(value - 1)}/><span>/ {pages.length}</span></label>
          <input className="nc-reader-progress" type="range" aria-label={msg('阅读进度')} min={1} max={Math.max(1, pages.length)} value={index + 1} disabled={pages.length < 2} onChange={event => jump(Number(event.target.value) - 1)}/>
          <button aria-label={msg('下一页')} disabled={!pages.length || index >= pages.length - 1} onClick={() => jump(index + 1)}><Icon name="chevron" style={{transform: 'rotate(90deg)'}}/></button>
        </div>
      </ReaderNavigation>
      <ReaderTools label={msg('翻译与阅读工具')} above={2} below={1}>
        <div className="nc-page-versions" role="group" aria-label={msg('漫画查看方式')}>
          <button aria-label={msg('原图')} aria-pressed={view === 'original'} onClick={() => selectView('original')}><Icon name="image"/><span>{msg('原图')}</span></button>
          <button aria-label={msg('译图')} aria-pressed={view === 'translation'} onClick={() => selectView('translation')}><Icon name="translate"/><span>{msg('译图')}</span></button>
        </div>
        <span className="nc-rail-divider" aria-hidden="true"/>
        <ReaderSettingsButton open={panel === 'settings'} onClick={() => togglePanel('settings')}/>
      </ReaderTools>
      {(notice || message) && <div className="nc-session-notice" role="status">{message || notice}</div>}
      {props.loading && <div className="nc-session-loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true"/><span>{msg('正在准备页面…')}</span></div>}
      <div className="nc-reading-viewport" data-reader-viewport="true" data-decoded-pages={foreground ? mountedIds.length : 0} data-page-count={pages.length}
        aria-busy={props.loading}
        tabIndex={0} ref={viewport} onScroll={scroll} onClick={event => {
          const selection = window.getSelection();
          if (event.defaultPrevented || (event.target as Element).closest('button,a,input,select,textarea,[role="button"],[contenteditable]') ||
            selection?.toString() && event.currentTarget.contains(selection.anchorNode)) return;
          toggleControls();
        }}>
        <div className="nc-reading-surface">
          <div className="nc-page-stack" ref={node => {if (node) stacks.current.set(copy.id, node); else stacks.current.delete(copy.id);}}>
            {settings.layout === 'continuous' && <div aria-hidden="true" style={{height: currentWindow.before}}/>}
            {pages.slice(currentWindow.start, currentWindow.end).map((page, localIndex) => {
              const at = currentWindow.start + localIndex, frame = pageFrame(copy.pages[at], viewportSize, sizing.fit, sizing.zoom);
              return <div className="nc-manga-page" key={page.id} data-page-id={page.id} data-page-index={at} style={{width: frame.width, height: frame.height}}>
                <div className="nc-page-picture" style={{height: frame.height}}>
                  <SessionPicture page={page} view={view} active={foreground} loadImage={loadImage} onDimensions={(width, height) => resizeImage(page.id, width, height)}/>
                </div>
                {view === 'translation' && page.status && <div className="nc-image-status-layer"><ImageTranslationStatus state={page.status}
                  onUpgrade={() => props.onRetry?.(page.id)} onLogin={() => props.onRetry?.(page.id)} onRetry={() => props.onRetry?.(page.id)}/></div>}
              </div>;
            })}
            {settings.layout === 'continuous' && <div aria-hidden="true" style={{height: currentWindow.after}}/>}
          </div>
          <div className="nc-reader-end"><p>{complete ? msg('已到当前内容末尾') : msg('当前已发现 {0} 页', {'0': pages.length})}</p>
            {!complete && onReload && <button className="button secondary" disabled={props.loading} onClick={onReload}>{msg('重新载入')}</button>}
          </div>
        </div>
      </div>
      {panel && <ReaderDrawer kind={panel} title={panel === 'directory' ? msg('页面') : msg('阅读设置')} label={panel === 'directory' ? msg('漫画目录') : msg('阅读设置')} onClose={closePanel}>
        <div className="nc-drawer-content">{panel === 'directory' ? <>
          <h3>{title}</h3><p>{msg('当前已发现 {0} 页', {'0': pages.length})}</p>
          <ReaderNumberInput label={msg('跳转页码')} value={pages.length ? index + 1 : 0} max={pages.length} disabled={!pages.length} onCommit={value => selectPage(value - 1)}/>
          <div className="nc-session-pages">{pages.slice(Math.max(0, index - 30), index + 31).map((page, offset) => {
            const at = Math.max(0, index - 30) + offset;
            return <button className="button secondary" key={page.id} aria-current={at === index ? 'page' : undefined} onClick={() => selectPage(at)}>{msg('第 {0} 页', {'0': at + 1})}</button>;
          })}</div>
        </> : <>
          <ReaderDisplaySettings settings={settings} setSettings={setSettings} onLayout={layout => {preserve(); setSettings(value => ({...value, layout}));}}
            sizing={<><ReaderChoice label={msg('图片适应方式')} value={sizing.fit} options={[{id: 'window', label: msg('适应窗口')}, {id: 'width', label: msg('铺满宽度')}]} onChange={fit => resizeView({fit})}/>
              <ReaderScale label={msg('缩放')} value={sizing.zoom} min={40} max={200} onChange={zoom => resizeView({zoom})}/></>}/>
          <div className="nc-stack-actions">
            <button className="button secondary" onClick={() => void fullscreen()}><Icon name="expand"/>{msg('全屏阅读')}</button>
            {onReload && <button className="button secondary" disabled={props.loading} onClick={() => {preserve(); persist(); onReload();}}><Icon name="refresh"/>{msg('重新载入')}</button>}
            {onSelectRegion && <button className="button secondary" onClick={() => {preserve(); persist(); onSelectRegion();}}><Icon name="expand"/>{msg('选择正文区域')}</button>}
            {onImport && <button className="button secondary" onClick={() => {preserve(); persist(); onImport();}}><Icon name="folder"/>{msg('加入书架')}</button>}
          </div>
        </>}</div>
      </ReaderDrawer>}
    </ReaderShell>
  </div>;
}
