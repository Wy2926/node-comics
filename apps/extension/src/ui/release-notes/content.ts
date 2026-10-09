import {version} from '../../../package.json';

/** Bundled with the extension; the package version also drives the browser manifest. */
export const releaseNotes = {
  version,
  highlights: [
    {icon: 'translate', title: 'releaseNotes.models.title', artwork: 'models'},
    {icon: 'crown', title: 'releaseNotes.subscription.title', artwork: 'subscription'},
    {icon: 'pricing', title: 'releaseNotes.packs.title', artwork: 'packs'},
    {icon: 'user', title: 'releaseNotes.account.title'},
    {icon: 'globe', title: 'releaseNotes.sources.title', sites: ['ComicK (comickz)', 'ComicWalker', "HERO'S Web"]},
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
