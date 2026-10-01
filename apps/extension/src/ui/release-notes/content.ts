import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'globe', title: 'releaseNotes.sources.title', body: 'releaseNotes.sources.body'},
    {icon: 'comic-search', title: 'releaseNotes.text.title', body: 'releaseNotes.text.body'},
    {icon: 'translate', title: 'releaseNotes.images.title', body: 'releaseNotes.images.body'},
    {icon: 'book', title: 'releaseNotes.reading.title', body: 'releaseNotes.reading.body'},
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
