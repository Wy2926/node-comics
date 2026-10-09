import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {version} from '../package.json';
import lock from '../package-lock.json';
import zh from '../src/i18n/dictionaries/zh-CN.json';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('release notes first use', () => {
  it('ships the current model, pricing, quota and source changes with one package version', async () => {
    const {releaseNotes} = await import('../src/ui/release-notes/content');
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(releaseNotes.highlights.map(item => item.title)).toEqual([
      'releaseNotes.models.title', 'releaseNotes.subscription.title', 'releaseNotes.packs.title',
      'releaseNotes.account.title', 'releaseNotes.sources.title',
    ]);
    expect(releaseNotes.highlights.at(-1)).toMatchObject({sites: ['ComicK (comickz)', 'ComicWalker', "HERO'S Web"]});
    expect(zh['releaseNotes.subscription.title']).toContain('资费大幅降低');
    expect(zh['releaseNotes.hint']).toContain('官网定价页');
    expect(Object.keys(zh).filter(key => /^releaseNotes\.(remote|ocr|prefetch|epub|region|shortcuts)\./.test(key))).toEqual([]);
  });

  it.each([null, `${version}-previous`, 'invalid'])('offers the current release for an unseen version (%s)', async saved => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', {getItem: () => saved, setItem});
    const notes = await import('../src/ui/release-notes/content');
    expect(notes.releaseNotes.version).toBe(version);
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
