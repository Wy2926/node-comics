import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'cloud', title: 'releaseNotes.remote.title', artwork: 'remote'},
    {icon: 'comic-search', title: 'releaseNotes.ocr.title', artwork: 'ocr'},
    {icon: 'translate', title: 'releaseNotes.prefetch.title', artwork: 'prefetch'},
    {icon: 'book', title: 'releaseNotes.epub.title'},
    {icon: 'expand', title: 'releaseNotes.region.title'},
    {icon: 'keyboard', title: 'releaseNotes.shortcuts.title'},
    {icon: 'globe', title: 'releaseNotes.sources.title', sites: ['MangaPill', 'MangaDNA', 'KLManga', 'RawLazy', 'Comic DAYS', 'Manga One']},
  ],
} as const;

export const releaseNotesStorageKey = 'nc-release-notes-version';
let seenInSession = '';

export function hasUnseenReleaseNotes(): boolean {
  if (seenInSession === version) return false;
  try { return localStorage.getItem(releaseNotesStorageKey) !== version; }
  catch { return true; }
}

/** Only called after the dialog opens. Optional storage must never block the UI. */
export function markReleaseNotesSeen() {
  seenInSession = version;
  try { localStorage.setItem(releaseNotesStorageKey, version); }
  catch { /* Avoid repeated prompts in this page even when persistence is unavailable. */ }
}
