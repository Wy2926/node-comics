import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'book', title: 'releaseNotes.spreads.title', description: 'releaseNotes.spreads.description'},
    {icon: 'download', title: 'releaseNotes.export.title', description: 'releaseNotes.export.description'},
    {icon: 'globe', title: 'releaseNotes.sources.title', description: 'releaseNotes.sources.description'},
    {icon: 'settings', title: 'releaseNotes.experience.title', description: 'releaseNotes.experience.description'},
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
