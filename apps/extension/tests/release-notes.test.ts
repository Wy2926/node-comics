import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {version} from '../package.json';
import lock from '../package-lock.json';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('release notes first use', () => {
  it('uses the package version and keeps each localized highlight short', async () => {
    const {releaseNotes} = await import('../src/ui/release-notes/content');
    expect(releaseNotes.version).toBe(version);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    const dictionaries = import.meta.glob<Record<string, string>>('../src/i18n/dictionaries/*.json', {eager: true, import: 'default'});
    for (const [locale,dictionary] of Object.entries(dictionaries))
      for (const {description} of releaseNotes.highlights) expect(dictionary[description].length,`${locale}: ${description}`).toBeLessThanOrEqual(160);
  });

  it.each([null, '1.6.0', 'invalid'])('offers the current release for an unseen version (%s)', async saved => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', {getItem: () => saved, setItem});
    const notes = await import('../src/ui/release-notes/content');
    expect(notes.hasUnseenReleaseNotes()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    notes.markReleaseNotesSeen();
    expect(setItem).toHaveBeenCalledWith(notes.releaseNotesStorageKey, version);
    expect(notes.hasUnseenReleaseNotes()).toBe(false);
  });

  it('does not prompt again when the installed version has already been viewed', async () => {
    vi.stubGlobal('localStorage', {getItem: () => version});
    const notes = await import('../src/ui/release-notes/content');
    expect(notes.hasUnseenReleaseNotes()).toBe(false);
  });

  it('keeps the notes available without repeating the prompt when storage fails', async () => {
    vi.stubGlobal('localStorage', {getItem: () => {throw Error('Unavailable');}, setItem: () => {throw Error('Quota exceeded');}});
    const notes = await import('../src/ui/release-notes/content');
    expect(notes.hasUnseenReleaseNotes()).toBe(true);
    expect(() => notes.markReleaseNotesSeen()).not.toThrow();
    expect(notes.hasUnseenReleaseNotes()).toBe(false);
  });
});
