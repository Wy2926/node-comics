import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'translate', title: 'releaseNotes.dialogue.title', description: 'releaseNotes.dialogue.description'},
    {icon: 'image', title: 'releaseNotes.longPages.title', description: 'releaseNotes.longPages.description'},
    {icon: 'settings', title: 'releaseNotes.prompt.title', description: 'releaseNotes.prompt.description'},
    {icon: 'globe', title: 'releaseNotes.linkReading.title', description: 'releaseNotes.linkReading.description'},
    {icon: 'message', title: 'releaseNotes.reviews.title', description: 'releaseNotes.reviews.description'},
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
