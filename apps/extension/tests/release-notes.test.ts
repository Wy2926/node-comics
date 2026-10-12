import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {version} from '../package.json';
import lock from '../package-lock.json';
import zh from '../src/i18n/dictionaries/zh-CN.json';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('release notes first use', () => {
  it('ships changes since 0.11.3 with one package version', async () => {
    const {releaseNotes} = await import('../src/ui/release-notes/content');
    expect(version).toBe('0.12.0');
    expect(releaseNotes.version).toBe(version);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(releaseNotes.highlights.map(item => item.title)).toEqual([
      'releaseNotes.enhancement.title', 'releaseNotes.directory.title', 'releaseNotes.documents.title',
      'releaseNotes.sources.title', 'releaseNotes.reliability.title',
    ]);
    expect(releaseNotes.highlights.find(item => 'sites' in item)).toMatchObject({
      sites: ['COMIC FUZ', 'Zebrack', '再漫画', 'Manga One', 'Hachiraw', 'MangaTaro', 'WebtoonScan'],
    });
    for (const item of releaseNotes.highlights) expect(zh[item.description].trim()).not.toBe('');
    expect(zh['releaseNotes.intro']).toBe('v{version} · 本次更新亮点。');
    expect(Object.entries(zh).filter(([key]) => key.startsWith('releaseNotes.')).some(([, value]) => value.includes('0.11.3'))).toBe(false);
    expect(zh['releaseNotes.enhancement.description']).toContain('nunif / waifu2x');
    expect(zh['releaseNotes.documents.title']).toContain('官网');
    expect(zh['releaseNotes.hint']).toContain('默认关闭');
    expect(Object.keys(zh).filter(key => /^releaseNotes\.(models|subscription|packs|account)\./.test(key))).toEqual([]);
  });

  it.each([null, '0.11.3', `${version}-previous`, 'invalid'])('offers the current release for an unseen version (%s)', async saved => {
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
