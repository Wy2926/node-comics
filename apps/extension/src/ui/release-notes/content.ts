import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'book', title: 'releaseNotes.epubImport.title', description: 'releaseNotes.epubImport.description'},
    {icon: 'split', title: 'releaseNotes.doublePage.title', description: 'releaseNotes.doublePage.description'},
    {icon: 'coin', title: 'releaseNotes.modelQuota.title', description: 'releaseNotes.modelQuota.description'},
    {icon: 'globe', title: 'releaseNotes.siteSupport.title', description: 'releaseNotes.siteSupport.description'},
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
