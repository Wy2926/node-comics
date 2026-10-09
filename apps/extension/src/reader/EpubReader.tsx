import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type Rendition from "epubjs/types/rendition";
import type { Location } from "epubjs/types/rendition";
import type { EpubSession } from "../comics/formats/epub";
import {EpubNavigation, flattenEpubToc} from '../comics/formats/epub/navigation';
import {
  currentEpubLocation,
  epubProgression,
  initializeEpubLocation,
  resizeEpub,
  restoreEpubLocation,
  settleEpubLayout,
  turnEpub,
} from "../comics/formats/epub/location";
import { openEpubEntry } from "../comics/application/epub-service";
import { Icon } from "../icons";
import { msg } from "../i18n/runtime";
import {languageLabel, modeLabels, type Capabilities, type Mode, type Page, type ReadingEntry, type Settings} from "../types";
import type {ReadingTarget, TranslationState} from '../translation/automatic';
import { useShortcuts } from "../shortcuts/react";
import type {ReadingProgressStatus} from '../comics/application/reading-progress';
import {ReaderShell, ReaderNavigation, ReaderDrawer, ReaderNumberInput} from './ReaderChrome';
import {ReaderSettings, ReaderScale, ReaderTranslationSettings} from './ReaderSettings';
import {PageTranslationBar} from './PageTranslationBar';
import {EpubDirectory} from './EpubDirectory';
import {ImageTranslationStatus} from './ImageTranslationStatus';
import {useReaderControls} from './useReaderControls';
import {useEpubImages} from './useEpubImages';
import {readReadingView, saveReadingView} from './view';
import "./epub.css";

interface Props {
  copy: ReadingEntry;
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  update(next: ReadingEntry): void;
  onBack(): void;
  backLabel: string;
  backText: string;
  viewKey: string;
  controlsBlocked?: boolean;
  onOpenShortcuts(): void;
  notify(message: string): void;
  caps?: Capabilities; modelSelection?:import('../translation/channels/contracts').ModelSelection;
  channelLabel?: string;
  translationScope?: string;
  onReadingWindow(targets: ReadingTarget[], visible: Page[], immediate?: boolean): void;
  translationState(entryId: string, page: Page, mode: Mode): TranslationState | undefined;
  onRetry(page: Page, mode: Mode): void | Promise<void>;
  onLogin(): void;
  onUpgrade(): void;
  progressStatus?: ReadingProgressStatus;
}

function applyAppearance(
  view: Rendition,
  settings: Settings,
  fontSize: number,
  root: HTMLElement,
) {
  const tokens = getComputedStyle(root);
  const fixed = view.settings.layout === 'pre-paginated';
  view.themes.default({
    html: {background: `${tokens.getPropertyValue('--reading-background').trim()} !important`},
    body: {
      color: `${tokens.getPropertyValue('--reading-ink').trim()} !important`,
      background: `${tokens.getPropertyValue('--reading-background').trim()} !important`,
      ...(!fixed ? {"line-height": "1.65 !important"} : {}),
    },
    a: { color: `${tokens.getPropertyValue('--reading-link').trim()} !important` },
  });
  if (!fixed) view.themes.fontSize(`${fontSize * settings.textScale}%`);
}

/** EPUB text is a document. It never enters bitmap page/translation materialization. */
export function EpubReader({
  copy,
  settings,
  setSettings,
  update,
  onBack,
  backLabel,
  backText,
  viewKey,
  controlsBlocked = false,
  onOpenShortcuts,
  notify,
  caps, modelSelection,
  channelLabel,
  translationScope,
  onReadingWindow,
  translationState,
  onRetry,
  onLogin,
  onUpgrade,
  progressStatus,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const session = useRef<EpubSession | undefined>(undefined);
  const rendition = useRef<Rendition | undefined>(undefined);
  const positioning = useRef(true);
  const capturePosition = useRef<(() => void) | undefined>(undefined);
  const reflow = useRef<(() => void) | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [fixedLayout, setFixedLayout] = useState(false);
  const [view, setView] = useState(() => readReadingView(viewKey));
  const fontSize = Math.max(70, view.zoom);
  const setFontSize = (value: number | ((previous: number) => number)) => {if (!fixedLayout) setView(previous => ({...previous, zoom: Math.max(70, Math.min(200, typeof value === 'function' ? value(previous.zoom) : value))}));};
  const {root, panel, setPanel, togglePanel, closePanel, immersive, setImmersive, hidden, reveal, fullscreen} = useReaderControls<'directory' | 'settings' | 'translation'>({blocked: controlsBlocked, notify});
  const images = useEpubImages({copy, update, translated: view.preference === 'translation', mode: view.mode, language: settings.language, scope: translationScope, onReadingWindow});
  const latest = useRef({ copy, update, settings, fontSize, images, panel, reveal, setPanel });
  latest.current = { copy, update, settings, fontSize, images, panel, reveal, setPanel };
  const [position, setPosition] = useState<Location>();
  const [tocHref, setTocHref] = useState<string>();
  const leaveReader = () => {capturePosition.current?.();onBack();};
  const chapters = useMemo(() => copy.document ? flattenEpubToc(copy.document.toc.length ? copy.document.toc : copy.document.chapters) : [], [copy.document]);
  const chapterCount = chapters.length;
  const activeHref = tocHref ?? position?.start.href.replace(/^\//, '') ?? copy.documentLocation?.href;
  const chapter = Math.max(0, chapters.findIndex(item => item.href === activeHref));
  const progress = Math.round((copy.documentLocation?.totalProgression ?? 0) * 100);
  const language = caps?.languages.find(value => value.id === settings.language)?.label ?? languageLabel(settings.language);
  function selectView(value: 'original' | Mode) {
    if (value !== 'original' && caps && !caps.modes.some(mode => mode.id === value && mode.enabled)) return false;
    setView(previous => ({...previous, mode: value === 'original' ? previous.mode : value, preference: value === 'original' ? 'original' : 'translation'}));
  }
  function jumpChapter(index: number) {
    const chapter = chapters[Math.max(0, Math.min(chapterCount - 1, index))];
    if (chapter) run(() => rendition.current!.display(`/${chapter.href}`));
  }
  useEffect(() => saveReadingView(viewKey, view), [viewKey, view]);

  const run = (operation: () => Promise<unknown>) => {
    if (loading || positioning.current || session.current?.signal?.aborted)
      return;
    void operation().catch(() => setError(msg("加载失败")));
  };
  useShortcuts(
    {
      "reader.previous": () => run(() => turnEpub(rendition.current!, -1)),
      "reader.next": () => run(() => turnEpub(rendition.current!, 1)),
      "reader.left": () =>
        run(() =>
          turnEpub(rendition.current!, settings.direction === "rtl" ? 1 : -1),
        ),
      "reader.right": () =>
        run(() =>
          turnEpub(rendition.current!, settings.direction === "rtl" ? -1 : 1),
        ),
      "reader.first": () => jumpChapter(0),
      "reader.last": () => jumpChapter(chapterCount - 1),
      "reader.directory": () => togglePanel('directory'),
      "reader.settings": () => togglePanel('settings'),
      "reader.translationSettings": () => togglePanel('translation'),
      "reader.original": () => selectView('original'),
      "reader.translation": () => selectView('classic'),
      "reader.immersive": () => setImmersive(value => !value),
      "reader.fullscreen": () => {void fullscreen();},
      "reader.layout": () => setSettings(value => ({...value, layout: value.layout === 'continuous' ? 'single' : 'continuous'})),
      "reader.zoomIn": () => setFontSize((value) => Math.min(200, value + 10)),
      "reader.zoomOut": () => setFontSize((value) => Math.max(70, value - 10)),
      "reader.zoomReset": () => setFontSize(100),
      "reader.back": leaveReader,
    },
    { enabled: !controlsBlocked },
  );

  // Capture/release while the iframe is still attached. Firefox no longer exposes
  // its computed styles after React removes it, before passive effect cleanup.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !copy.contentId) return;
    const controller = new AbortController();
    let current: EpubSession | undefined;
    positioning.current = true;
    let failed = false;
    let resize: ResizeObserver | undefined;
    let resizePending = false;
    let displayTimeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    setLoading(true);
    setError("");
    setPosition(undefined);
    setTocHref(undefined);
    const fail = () => {
      if (controller.signal.aborted || failed) return;
      failed = true;
      resize?.disconnect();
      reflow.current = undefined;
      rendition.current = undefined;
      element.replaceChildren();
      void current?.close();
      setLoading(false);
      setError(msg("加载失败"));
    };
    void (async () => {
      current = await openEpubEntry(
        copy.id,
        copy.contentId!,
        controller.signal,
      );
      if (controller.signal.aborted) {
        await current.close();
        return;
      }
      session.current = current;
      const revoked = () => {
        reflow.current = undefined;
        rendition.current = undefined;
        element.replaceChildren();
        setLoading(false);
        setError(msg("加载失败"));
      };
      current.signal?.addEventListener("abort", revoked, { once: true });
      removeAbort = () =>
        current?.signal?.removeEventListener("abort", revoked);
      current.signal?.throwIfAborted();
      const view = current.render(element, {
        // A single ResizeObserver owns layout; the library's percent-size window listener
        // can otherwise clear an iframe before its first navigation finishes.
        width: element.clientWidth,
        height: element.clientHeight,
        spread: "none",
        defaultDirection: latest.current.settings.direction,
        flow:
          latest.current.settings.layout === "continuous"
            ? "scrolled-continuous"
            : "paginated",
      });
      rendition.current = view;
      latest.current.images.connect(view, current.signal ?? controller.signal);
      view.on("displayError", fail);
      displayTimeout = setTimeout(fail, 30_000);
      const navigation = new EpubNavigation(current.index);
      const recordPosition = (location: Location) => {
        if (
          controller.signal.aborted ||
          current?.signal?.aborted ||
          !location.start?.cfi
        )
          return;
        setPosition(location);
        setTocHref(navigation.current(view, location));
        if (positioning.current) return;
        const { copy: latestCopy, update: persist } = latest.current;
        // Layout/initial restoration is not a new reading action or a newer sync timestamp.
        const total = current!.index.chapters.length;
        const withinChapter = epubProgression(view, location);
        if (latestCopy.documentLocation?.cfi === location.start.cfi &&
          (view.settings.layout !== 'pre-paginated' || Math.abs((latestCopy.documentLocation.progression ?? 0) - withinChapter) < 0.001)) return;
        const totalProgression = location.atEnd
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                (location.start.index + withinChapter) / Math.max(1, total),
              ),
            );
        const next: ReadingEntry = {
          ...latestCopy,
          documentLocation: {
            cfi: location.start.cfi,
            href: location.start.href.replace(/^\//, ""),
            progression: withinChapter,
            totalProgression,
          },
          lastReadAt: Date.now(),
        };
        latest.current.copy=next;
        persist(next);
      };
      view.on("relocated", recordPosition);
      capturePosition.current=()=>{
        if(positioning.current||failed||controller.signal.aborted||current?.signal?.aborted)return;
        const location=currentEpubLocation(view);
        if(location?.start)recordPosition(location);
      };
      view.on("keydown", (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
        // Iframe keyboard events do not bubble; keep the existing customizable shortcut registry.
        const forwarded = new KeyboardEvent("keydown", {
          ...event,
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          isComposing: event.isComposing,
          cancelable: true,
        });
        window.dispatchEvent(forwarded);
        if (forwarded.defaultPrevented) event.preventDefault();
      });
      view.on("keyup", (event: KeyboardEvent) =>
        window.dispatchEvent(
          new KeyboardEvent("keyup", { key: event.key, code: event.code }),
        ),
      );
      view.on('click', (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (target?.closest('a') || target?.ownerDocument.getSelection()?.toString()) return;
        if (latest.current.panel) latest.current.setPanel(undefined);
        else latest.current.reveal();
      });
      await view.started;
      current.signal?.throwIfAborted();
      setFixedLayout(view.settings.layout === 'pre-paginated');
      view.direction(latest.current.settings.direction);
      const saved = latest.current.copy.documentLocation;
      await initializeEpubLocation(current, view, saved, () =>
        applyAppearance(view, latest.current.settings, latest.current.fontSize, root.current!),
      );
      if (!failed && !controller.signal.aborted && !current.signal?.aborted) {
        let pendingAppearance = false;
        let changingAppearance = false;
        reflow.current = () => {
          if (failed || controller.signal.aborted || current?.signal?.aborted)
            return;
          pendingAppearance = true;
          if (changingAppearance) return;
          changingAppearance = true;
          positioning.current = true;
          const location = currentEpubLocation(view);
          const anchor = location?.start
            ? {
                cfi: location.start.cfi,
                href: location.start.href.replace(/^\//, ""),
                progression: epubProgression(view, location),
              }
            : latest.current.copy.documentLocation;
          void (async () => {
            do {
              pendingAppearance = false;
              applyAppearance(
                view,
                latest.current.settings,
                latest.current.fontSize,
                root.current!,
              );
              await settleEpubLayout(view, current!.signal);
              await restoreEpubLocation(current!, view, anchor);
            } while (pendingAppearance && !current?.signal?.aborted);
          })()
            .catch(fail)
            .finally(() => {
              changingAppearance = false;
              if (
                !failed &&
                !controller.signal.aborted &&
                !current?.signal?.aborted
              ) {
                positioning.current = false;
                void view.reportLocation();
              }
            });
        };
        // renderTo queues manager initialization and attachment; resize is synchronous.
        resize = new ResizeObserver(() => {
          if (resizePending || failed || controller.signal.aborted) return;
          resizePending = true;
          void view.q
            .enqueue(() => {
              resizePending = false;
              if (
                !failed &&
                !controller.signal.aborted &&
                !current?.signal?.aborted
              ) {
                resizeEpub(view, element.clientWidth, element.clientHeight);
              }
            })
            .catch(fail);
        });
        resize.observe(element);
        positioning.current = false;
        void view.reportLocation();
        setLoading(false);
      }
    })()
      .catch(fail)
      .finally(() => clearTimeout(displayTimeout));
    return () => {
      capturePosition.current?.();
      capturePosition.current=undefined;
      clearTimeout(displayTimeout);
      removeAbort?.();
      resize?.disconnect();
      controller.abort();
      rendition.current = undefined;
      reflow.current = undefined;
      session.current = undefined;
      element.replaceChildren();
      void current?.close();
    };
    // EPUB.js changes flow/direction through overlapping clear/display operations,
    // especially for fixed layouts. Reopen the bounded session around the captured
    // source location instead; this runs only on an explicit layout/direction change.
  }, [copy.id, copy.contentId, retry, settings.layout, settings.direction]);

  useEffect(()=>{
    const save=()=>capturePosition.current?.();
    const hidden=()=>{if(document.visibilityState==='hidden')save();};
    document.addEventListener('visibilitychange',hidden,true);
    window.addEventListener('pagehide',save);
    return()=>{document.removeEventListener('visibilitychange',hidden,true);window.removeEventListener('pagehide',save);};
  },[]);

  useEffect(() => {
    reflow.current?.();
  }, [fontSize, settings.readerBackground, settings.textScale, settings.appearance, settings.accentTheme]);

  const disabled = loading || !!error;
  return <ReaderShell ref={root} background={settings.readerBackground} immersive={immersive} hidden={hidden} reveal={reveal}>
    <ReaderNavigation backLabel={backLabel} backText={backText} title={copy.title} onBack={leaveReader}
      progressStatus={progressStatus} directoryOpen={panel === 'directory'} onDirectory={() => togglePanel('directory')}>
      <div className="nc-reader-navigation">
        <button aria-label={msg('上一页')} title={msg('上一页')} disabled={disabled || position?.atStart}
          onClick={() => run(() => turnEpub(rendition.current!, -1))}><Icon name="chevron" style={{transform: 'rotate(-90deg)'}}/></button>
        <label title={msg('第 {0} 章，共 {1} 章', {'0': chapter + 1, '1': chapterCount})}>
          <ReaderNumberInput label={msg('跳转章节')} value={chapter + 1} max={chapterCount} disabled={disabled}
            onCommit={value => jumpChapter(value - 1)}/><span>/ {chapterCount}</span>
        </label>
        <input className="nc-reader-progress" type="range" aria-label={msg('阅读进度')} aria-valuetext={`${progress}%`}
          min={0} max={100} step={1} value={progress} disabled={disabled}
          onChange={event => {
            const count = copy.document?.chapters.length ?? 0;
            const target = Number(event.target.value) / 100 * count;
            const index = Math.min(count - 1, Math.floor(target));
            const href = copy.document?.chapters[index]?.href;
            if (href) run(() => restoreEpubLocation(session.current!, rendition.current!, {href, progression: target - index}));
          }}/>
        <span className="nc-epub-progress-label">{progress}%</span>
        <button aria-label={msg('下一页')} title={msg('下一页')} disabled={disabled || position?.atEnd}
          onClick={() => run(() => turnEpub(rendition.current!, 1))}><Icon name="chevron" style={{transform: 'rotate(90deg)'}}/></button>
      </div>
    </ReaderNavigation>
    <PageTranslationBar selectedView={view.preference === 'original' ? 'original' : view.mode} onView={selectView}
      modes={caps?.modes.filter(mode => mode.enabled).map(mode => mode.id)} allowsFeedback={false} onFeedback={() => {}}
      translationLabel={msg('默认翻译 · {0} · {1}', {'0': modeLabels.classic, '1': language})} panel={panel} onPanel={togglePanel}/>
    <main className="nc-reading-viewport nc-epub-stage" data-epub-flow={settings.layout === 'continuous' ? 'scrolled-continuous' : 'paginated'}>
      <div ref={viewport} className="nc-epub-viewport" aria-busy={loading}/>
      {loading && <div className="nc-epub-status" role="status"><span className="spinner"/>{msg('加载中…')}</div>}
      {error && <div className="nc-epub-status" role="alert"><p>{error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>{msg('重试')}</button></div>}
      {!disabled && view.preference === 'translation' && (images.page || images.error) &&
        <ImageTranslationStatus state={images.error ? {kind: 'error', message: images.error} : translationState(copy.id, images.page!, view.mode)}
          onLogin={onLogin} onUpgrade={onUpgrade} onRetry={() => images.error ? images.retry() : onRetry(images.page!, view.mode)}/>}
    </main>
    {panel && <ReaderDrawer kind={panel} title={{directory: msg('目录'), settings: msg('阅读设置'), translation: msg('翻译设置')}[panel]}
      label={{directory: msg('目录'), settings: msg('阅读设置'), translation: msg('翻译选项')}[panel]} onClose={closePanel}>
      {panel === 'directory' && copy.document ? <EpubDirectory title={copy.title} index={copy.document}
        href={tocHref ?? position?.start.href ?? copy.documentLocation?.href} select={href => {run(() => rendition.current!.display(`/${href}`)); closePanel();}}/>
        : <div className="nc-drawer-content">{panel === 'translation'
          ? <ReaderTranslationSettings settings={settings} setSettings={setSettings} caps={caps} channelLabel={channelLabel} modelSelection={modelSelection}
            note={msg('仅翻译 EPUB 内的图片，正文文字保持原文。选择译图后，随读翻译可见图片与最多三张后续图片。')}/>
          : <ReaderSettings settings={settings} setSettings={setSettings} onLayout={layout => setSettings(value => ({...value, layout}))}
            sizing={fixedLayout ? null : <ReaderScale label={msg('字号')} value={fontSize} min={70} max={200} disabled={disabled} onChange={setFontSize}/>}
            immersive={immersive} onImmersive={() => setImmersive(value => !value)} onFullscreen={() => void fullscreen()}
            onShortcuts={() => {setPanel(undefined); reveal(); onOpenShortcuts();}} onReload={() => {capturePosition.current?.(); setRetry(value => value + 1);}}
            sourceUrl={copy.sourceUrl} busy={loading}/>}</div>}
    </ReaderDrawer>}
  </ReaderShell>;
}
