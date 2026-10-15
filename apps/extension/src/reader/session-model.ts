import type {Settings} from '../types';
import type {TranslationState} from '../translation/automatic';

/** Temporary reading state belongs to its document, never to the comic catalogue. */
export type SessionReaderView = 'original' | 'translation';
export interface SessionReaderAnchor {pageId: string; relativeOffset: number;}
export interface SessionReaderPage {
  id: string;
  name?: string;
  width: number;
  height: number;
  /** Change only this page when its original/result changes. Status-only updates need no reload. */
  revision?: string | number;
  status?: TranslationState;
}
export interface SessionReaderImage {
  blob: Blob;
  release(): void;
  width?: number;
  height?: number;
  translated?: boolean;
}
export interface SessionReaderWindow {
  pageIds: string[];
  visiblePageIds: string[];
  view: SessionReaderView;
  immediate: boolean;
}
export interface SessionReaderProps {
  title: string;
  pages: SessionReaderPage[];
  settings: Settings;
  setSettings(value: Settings | ((previous: Settings) => Settings)): void;
  loadImage(pageId: string, view: SessionReaderView, signal: AbortSignal): Promise<SessionReaderImage>;
  initialAnchor?: SessionReaderAnchor;
  initialView?: SessionReaderView;
  onExit(anchor: SessionReaderAnchor): void;
  onPosition?(anchor: SessionReaderAnchor): void;
  onReadingWindow?(window: SessionReaderWindow): void;
  onRetry?(pageId: string): void;
  onReload?(): void;
  onSelectRegion?(): void;
  onImport?(): void;
  complete?: boolean;
  notice?: string;
}

export function sessionAnchor(pages: readonly Pick<SessionReaderPage, 'id'>[], anchor?: SessionReaderAnchor): SessionReaderAnchor {
  const pageId = pages.some(page => page.id === anchor?.pageId) ? anchor!.pageId : pages[0]?.id ?? '';
  return {pageId, relativeOffset: pageId === anchor?.pageId && Number.isFinite(anchor.relativeOffset)
    ? Math.max(0, Math.min(1, anchor.relativeOffset)) : 0};
}
