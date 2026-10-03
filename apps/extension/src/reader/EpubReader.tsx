import { useEffect, useRef, useState } from "react";
import type Rendition from "epubjs/types/rendition";
import type { Location } from "epubjs/types/rendition";
import type { EpubTocItem } from "../comics/formats/contracts";
import type { EpubSession } from "../comics/formats/epub";
import {
  currentEpubLocation,
  epubProgression,
  initializeEpubLocation,
  resizeEpub,
  restoreEpubLocation,
  settleEpubLayout,
} from "../comics/formats/epub/location";
import { openEpubEntry } from "../comics/application/epub-service";
import { Icon } from "../icons";
import { msg } from "../i18n/runtime";
import type { ReadingEntry, Settings } from "../types";
import { useShortcuts } from "../shortcuts/react";
import "./epub.css";

interface Props {
  copy: ReadingEntry;
  settings: Settings;
  update(next: ReadingEntry): void;
  onBack(): void;
  backLabel: string;
}

function applyAppearance(
  view: Rendition,
  settings: Settings,
  fontSize: number,
) {
  const dark = settings.readerBackground === "night";
  view.themes.default({
    body: {
      color: `${dark ? "#e2e2e6" : "#25262b"} !important`,
      background: `${dark ? "#202126" : settings.readerBackground === "paper" ? "#f7f2e6" : "#fff"} !important`,
      "line-height": "1.65 !important",
    },
    a: { color: `${dark ? "#b1cfff" : "#32699c"} !important` },
  });
  view.themes.fontSize(`${fontSize}%`);
}

function ContentsList({
  items,
  select,
}: {
  items: EpubTocItem[];
  select(href: string): void;
}) {
  return (
    <ol>
      {items.map((item, index) => (
        <li key={`${item.href}:${index}`}>
          <button onClick={() => select(item.href)}>{item.label}</button>
          {item.children?.length ? (
            <ContentsList items={item.children} select={select} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** EPUB text is a document. It never enters bitmap page/translation materialization. */
export function EpubReader({
  copy,
  settings,
  update,
  onBack,
  backLabel,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const session = useRef<EpubSession | undefined>(undefined);
  const rendition = useRef<Rendition | undefined>(undefined);
  const positioning = useRef(true);
  const reflow = useRef<(() => void) | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [directory, setDirectory] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fontSize, setFontSize] = useState(
    Math.round(100 * settings.textScale),
  );
  const latest = useRef({ copy, update, settings, fontSize });
  latest.current = { copy, update, settings, fontSize };
  const [position, setPosition] = useState<Location>();

  const run = (operation: () => Promise<unknown>) => {
    if (loading || positioning.current || session.current?.signal?.aborted)
      return;
    void operation().catch(() => setError(msg("加载失败")));
  };
  useShortcuts(
    {
      "reader.previous": () => run(() => rendition.current!.prev()),
      "reader.next": () => run(() => rendition.current!.next()),
      "reader.left": () =>
        run(() =>
          settings.direction === "rtl"
            ? rendition.current!.next()
            : rendition.current!.prev(),
        ),
      "reader.right": () =>
        run(() =>
          settings.direction === "rtl"
            ? rendition.current!.prev()
            : rendition.current!.next(),
        ),
      "reader.directory": () => setDirectory((value) => !value),
      "reader.zoomIn": () => setFontSize((value) => Math.min(200, value + 10)),
      "reader.zoomOut": () => setFontSize((value) => Math.max(70, value - 10)),
      "reader.back": onBack,
    },
    { enabled: !loading && !error },
  );

  useEffect(() => {
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
        flow:
          latest.current.settings.layout === "continuous"
            ? "scrolled-doc"
            : "paginated",
      });
      rendition.current = view;
      view.on("displayError", fail);
      displayTimeout = setTimeout(fail, 30_000);
      view.on("relocated", (location: Location) => {
        if (
          controller.signal.aborted ||
          current?.signal?.aborted ||
          !location.start?.cfi
        )
          return;
        setPosition(location);
        if (positioning.current) return;
        const { copy: latestCopy, update: persist } = latest.current;
        const total = current!.index.chapters.length;
        const withinChapter = epubProgression(view);
        const totalProgression = location.atEnd
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                (location.start.index + withinChapter) / Math.max(1, total),
              ),
            );
        persist({
          ...latestCopy,
          documentLocation: {
            cfi: location.start.cfi,
            href: location.start.href.replace(/^\//, ""),
            progression: withinChapter,
            totalProgression,
          },
          lastReadAt: Date.now(),
        });
      });
      view.on("keydown", (event: KeyboardEvent) => {
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
      const saved = latest.current.copy.documentLocation;
      await initializeEpubLocation(current, view, saved, () =>
        applyAppearance(view, latest.current.settings, latest.current.fontSize),
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
              }
            : latest.current.copy.documentLocation;
          void (async () => {
            do {
              pendingAppearance = false;
              applyAppearance(
                view,
                latest.current.settings,
                latest.current.fontSize,
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
  }, [copy.id, copy.contentId, retry]);

  useEffect(() => {
    reflow.current?.();
  }, [fontSize, settings.readerBackground]);

  const toc = copy.document?.toc.length
    ? copy.document.toc
    : (copy.document?.chapters.map((chapter) => ({
        href: chapter.href,
        label: chapter.label,
      })) ?? []);
  return (
    <div
      className="epub-reader"
      data-reader-background={settings.readerBackground}
      data-epub-flow={
        settings.layout === "continuous" ? "scrolled-doc" : "paginated"
      }
    >
      <header className="epub-toolbar">
        <button className="epub-back" aria-label={backLabel} onClick={onBack}>
          <Icon name="arrow" style={{ transform: "rotate(180deg)" }} />
          <span>{backLabel}</span>
        </button>
        <h1>{copy.title}</h1>
        <button
          aria-label={msg("目录")}
          aria-expanded={directory}
          onClick={() => setDirectory((value) => !value)}
        >
          <Icon name="list" />
        </button>
        <button
          aria-label={msg("缩小")}
          disabled={loading || !!error || fontSize <= 70}
          onClick={() => setFontSize((value) => Math.max(70, value - 10))}
        >
          A−
        </button>
        <span className="epub-font-size">{fontSize}%</span>
        <button
          aria-label={msg("放大")}
          disabled={loading || !!error || fontSize >= 200}
          onClick={() => setFontSize((value) => Math.min(200, value + 10))}
        >
          A+
        </button>
      </header>
      <div className="epub-body">
        {directory ? (
          <nav className="epub-toc" aria-label={msg("目录")}>
            <ContentsList
              items={toc}
              select={(href) => {
                run(() => rendition.current!.display(`/${href}`));
                setDirectory(false);
              }}
            />
          </nav>
        ) : null}
        <main className="epub-stage">
          <div ref={viewport} className="epub-viewport" aria-busy={loading} />
          {loading ? (
            <div className="epub-status" role="status">
              <span className="spinner" />
              {msg("加载中…")}
            </div>
          ) : null}
          {error ? (
            <div className="epub-status" role="alert">
              <p>{error}</p>
              <button
                className="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                {msg("重试")}
              </button>
            </div>
          ) : null}
        </main>
      </div>
      <footer className="epub-footer">
        <button
          disabled={loading || !!error || position?.atStart}
          onClick={() => run(() => rendition.current!.prev())}
        >
          {msg("上一页")}
        </button>
        <span>
          {Math.round((copy.documentLocation?.totalProgression ?? 0) * 100)}%
        </span>
        <button
          disabled={loading || !!error || position?.atEnd}
          onClick={() => run(() => rendition.current!.next())}
        >
          {msg("下一页")}
        </button>
      </footer>
    </div>
  );
}
