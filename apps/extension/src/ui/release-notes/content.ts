import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'image', title: 'releaseNotes.enhancement.title', description: 'releaseNotes.enhancement.description', artwork: 'enhancement'},
    {icon: 'search', title: 'releaseNotes.directory.title', description: 'releaseNotes.directory.description', artwork: 'directory'},
    {icon: 'translate', title: 'releaseNotes.documents.title', description: 'releaseNotes.documents.description', artwork: 'documents'},
    {icon: 'globe', title: 'releaseNotes.sources.title', description: 'releaseNotes.sources.description',
      sites: ['COMIC FUZ', 'Zebrack', '再漫画', 'Manga One', 'Hachiraw', 'MangaTaro', 'WebtoonScan']},
    {icon: 'check', title: 'releaseNotes.reliability.title', description: 'releaseNotes.reliability.description'},
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
