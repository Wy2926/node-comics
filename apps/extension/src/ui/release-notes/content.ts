import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'translate', title: 'releaseNotes.siteTranslation.title', description: 'releaseNotes.siteTranslation.description'},
    {icon: 'refresh', title: 'releaseNotes.comicUpdates.title', description: 'releaseNotes.comicUpdates.description'},
    {icon: 'book', title: 'releaseNotes.pdfReading.title', description: 'releaseNotes.pdfReading.description'},
    {icon: 'user', title: 'releaseNotes.accountStability.title', description: 'releaseNotes.accountStability.description'},
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
