import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';
import {version} from '../package.json';
import lock from '../package-lock.json';
import zh from '../src/i18n/dictionaries/zh-CN.json';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('release notes first use', () => {
  it('ships the first official release with one version and four concise localized highlights', async () => {
    const {releaseNotes} = await import('../src/ui/release-notes/content');
    expect(version).toBe('1.0.0');
    expect(releaseNotes.version).toBe(version);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(releaseNotes.highlights.map(item => item.title)).toEqual([
      'releaseNotes.spreads.title', 'releaseNotes.export.title', 'releaseNotes.sources.title', 'releaseNotes.experience.title',
    ]);
    for (const item of releaseNotes.highlights) expect(zh[item.description].trim()).not.toBe('');
    expect(zh['releaseNotes.kicker']).toBe('首个正式版');
    expect(zh['releaseNotes.spreads.title']).toContain('双页');
    expect(zh['releaseNotes.export.description']).toContain('已有译图');
    expect(zh['releaseNotes.sources.title']).toContain('22');
    const dictionaries = import.meta.glob<Record<string, string>>('../src/i18n/dictionaries/*.json', {eager: true, import: 'default'});
    expect(Object.keys(dictionaries)).toHaveLength(16);
    const keys = Object.keys(zh).filter(key => key.startsWith('releaseNotes.'));
    expect(keys).toHaveLength(14);
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).filter(key => key.startsWith('releaseNotes.'))).toEqual(keys);
      for (const key of keys) expect(dictionary[key].trim(), key).not.toBe('');
      expect(dictionary['releaseNotes.trigger']).toContain('{version}');
      expect(dictionary['releaseNotes.sources.title']).toContain('22');
      for (const item of releaseNotes.highlights) expect(dictionary[item.description].length).toBeLessThanOrEqual(160);
      expect(Object.entries(dictionary).filter(([key]) => key.startsWith('releaseNotes.')).some(([, value]) => /0\.11\.3|0\.12\.0|nunif|waifu2x/.test(value))).toBe(false);
      expect(keys).not.toContain('releaseNotes.hint');
      expect(keys).not.toContain('releaseNotes.intro');
    }
  });

  it.each([null, '0.11.3', '0.12.0', `${version}-previous`, 'invalid'])('offers the current release for an unseen version (%s)', async saved => {
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
