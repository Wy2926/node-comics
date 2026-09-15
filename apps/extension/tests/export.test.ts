import {describe, expect, it, vi} from 'vitest';
import {attachCopy, emptyLibrary, makeCopy} from '../src/library/model';
import {emptyPage} from '../src/reader/model';
import {exportCopies, exportManifest, planExport, safeName, type ExportOptions} from '../src/export/plan';
import {writeExport} from '../src/export/files';
import type {Job} from '../src/types';

const options: ExportOptions = {format: 'cbz', images: 'both', language: 'zh-Hans', mode: 'classic'};
function sample() {
  const state = emptyLibrary();
  const copy = makeCopy('第 2 话', [0, 1, 2].map(n => ({...emptyPage('page-' + n, 600, 900), blobKey: 'original-' + n, ownerId: 'alice', apiOrigin: 'https://api.example'})));
  const workId = attachCopy(state, copy, {title: '样本', kind: 'chapter'});
  const blobs = new Map(copy.pages.map(p => [p.blobKey!, new Blob(['original'])]));
  return {state, copy, workId, blobs, get: async (key: string) => blobs.get(key)};
}
function job(id: string, overrides: Partial<Job> = {}): Job {
  return {id, input_asset_id: 'in', output_asset_id: id + '-asset', mode: 'classic', target_language: 'zh-Hans', status: 'succeeded', phase: 'done', cost: 0, created_at: '2026-09-15T00:00:00Z', version: 1, cache_hit: false, ...overrides};
}

describe('export planning', () => {
  it('exports a shared copy once, keeps distinct sources, and orders by catalogue order', () => {
    const s = sample();
    s.state.coverage.push({...s.state.coverage[0], id: 'another-coverage'});
    const first = makeCopy('第 1 话', [emptyPage('one', 1, 1)]);
    attachCopy(s.state, first, {workId: s.workId, title: '样本', kind: 'chapter'});
    s.state.chapters[1].order = -1;
    const variant = {...s.copy, id: 'second-source', source: '另一来源'};
    attachCopy(s.state, variant, {workId: s.workId, title: '样本', kind: 'chapter', targetId: s.state.chapters[0].id});
    attachCopy(s.state, s.copy, {title: '另一作品', kind: 'work'});
    const entries = exportCopies(s.state, [s.copy, first, variant], s.workId);
    expect(entries.map(e => e.copy.id)).toEqual([first.id, s.copy.id, variant.id].sort((a, b) => a === first.id ? -1 : b === first.id ? 1 : a.localeCompare(b)));
    expect(entries.find(e => e.copy.id === s.copy.id)?.otherWorks).toEqual(['另一作品']);
    expect(entries.find(e => e.copy.id === s.copy.id)?.coverage).toEqual(['第 2 话']);
  });
  it('keeps current page order and separates originals from latest translated results', async () => {
    const s = sample();
    s.copy.pages[0].jobs = [job('old'), job('new', {version: 2}), job('pending', {status: 'running', version: 3})];
    s.copy.pages[0].outputBlobs = {new: 'translated'}; s.blobs.set('translated', new Blob(['translated']));
    s.copy.pages[1].jobs = [job('blank', {status: 'no_text', output_asset_id: null})];
    s.copy.pages.reverse();
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, 'alice', 'https://api.example');
    expect(p.books).toHaveLength(2);
    expect(p.books[0].pages.map(p => p.id)).toEqual(s.copy.pages.map(p => p.id));
    expect(p.books[1].pages.map(p => p.kind)).toEqual(['fallback', 'no_text', 'translation']);
    expect(p.books[1].pages[2]).toMatchObject({jobId: 'new', version: 2, blobKey: 'translated'});
    s.copy.pages.pop();
    expect(p.books[0].pages).toHaveLength(3);
  });
  it('checks actual blob presence, prefers local output after remote expiry, and never revives older versions', async () => {
    const s = sample();
    s.copy.pages[0].jobs = [job('old'), job('new', {version: 2, result_expired: true, output_asset_id: null})];
    s.copy.pages[0].outputBlobs = {old: 'old-blob', new: 'missing-blob'}; s.blobs.set('old-blob', new Blob(['old']));
    s.copy.pages[1].jobs = [job('local', {result_expired: true, output_asset_id: null})];
    s.copy.pages[1].outputBlobs = {local: 'local-blob'}; s.blobs.set('local-blob', new Blob(['local']));
    s.copy.pages[2].jobs = [job('remote')];
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, 'alice', 'https://api.example');
    expect(p.books[1].pages.map(p => p.kind)).toEqual(['fallback', 'translation', 'translation']);
    expect(p.books[1].pages[2].assetId).toBe('remote-asset');
  });
  it.each([['bob', 'https://api.example'], ['alice', 'https://other.example']])('does not export translations for another identity %s %s', async (owner, origin) => {
    const s = sample(); s.copy.pages[0].jobs = [job('private')]; s.copy.pages[0].outputBlobs = {private: 'private'}; s.blobs.set('private', new Blob(['private']));
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, owner, origin);
    expect(p.books[1].pages.every(p => p.kind === 'fallback' && !p.jobId && !p.assetId)).toBe(true);
  });
  it('flags partial discovery and missing images without losing original page slots', async () => {
    const s = sample(); s.copy.sourceEntryId = 'source'; s.copy.discoveryComplete = false; s.blobs.delete('original-1');
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), {...options, images: 'original'}, s.get);
    expect(p.books[0]).toMatchObject({incomplete: true, total: undefined});
    expect(p.books[0].pages[1]).toMatchObject({ordinal: 2, kind: 'missing'});
    expect(p.books[0].path).toContain('不完整');
    await expect(writeExport(p, {getBlob: s.get, download: vi.fn(), isCurrent: () => true, progress: vi.fn()}, new AbortController().signal)).rejects.toThrow('不完整');
  });
  it('omits raw source URLs, account details and blob/asset access identities from manifests', async () => {
    const s = sample(); s.copy.sourceUrl = 'https://private.example/?token=secret'; s.copy.pages[0].sourceUrl = s.copy.sourceUrl; s.copy.pages[0].jobs = [job('ok')];
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, 'alice', 'https://api.example');
    const manifest = JSON.stringify(exportManifest(p));
    for (const secret of ['token', 'secret', 'alice', 'api.example', 'sourceUrl', 'blobKey', 'assetId', 'ok-asset']) expect(manifest).not.toContain(secret);
  });
  it('stops cancelled inspections and stale or shared exports before any downloads', async () => {
    const s = sample(), signal = new AbortController(); signal.abort();
    await expect(planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, 'alice', '', signal.signal)).rejects.toThrow();
    attachCopy(s.state, s.copy, {title: '其他作品', kind: 'work'});
    const p = await planExport('样本', exportCopies(s.state, [s.copy], s.workId), options, s.get, 'alice', 'https://api.example');
    const download = vi.fn(), deps = {getBlob: s.get, download, isCurrent: () => true, progress: vi.fn()};
    await expect(writeExport(p, deps, new AbortController().signal)).rejects.toThrow('其他作品');
    await expect(writeExport(p, {...deps, isCurrent: () => false}, new AbortController().signal)).rejects.toThrow('账户');
    expect(download).not.toHaveBeenCalled();
  });
  it('produces portable names without traversal, controls or reserved Windows devices', () => {
    for (const name of ['../..\\目录:标题?*', 'CON', 'LPT1.txt', '..', '\u0000\u202eabc']) {
      const result = safeName(name);
      expect(result).not.toMatch(/[\\/:?*\u0000\u202e]/); expect(result).not.toMatch(/^[. ]|[. ]$/);
    }
    expect(safeName('CON')).toBe('_CON');
  });
  it('detects other works recorded only on a shared publication or its inclusions', () => {
    const s = sample();
    const other = makeCopy('另一作品的章节', []);
    const otherWork = attachCopy(s.state, other, {title: '另一作品', kind: 'chapter'});
    const book = makeCopy('合订册', []);
    attachCopy(s.state, book, {title: '样本', workId: s.workId, kind: 'publication'});
    s.state.publications[0].workIds.push(otherWork);
    expect(exportCopies(s.state, [book], s.workId)[0].otherWorks).toEqual(['另一作品']);
    s.state.publications[0].workIds = [s.workId];
    s.state.inclusions.push({id: 'inclusion', publicationId: s.state.publications[0].id, target: {kind: 'chapter', id: s.state.chapters[1].id}, order: 0, evidence: {status: 'user', source: 'test'}});
    expect(exportCopies(s.state, [book], s.workId)[0].otherWorks).toEqual(['另一作品']);
  });
  it('rejects post-inspection image eviction and account changes during a remote fetch', async () => {
    const s = sample(); s.copy.pages = [s.copy.pages[0]];
    const entries = exportCopies(s.state, [s.copy], s.workId);
    const original = await planExport('样本', entries, {...options, images: 'original'}, s.get);
    const deps = {getBlob: async () => undefined, download: vi.fn(), isCurrent: () => true, progress: vi.fn()};
    await expect(writeExport(original, deps, new AbortController().signal)).rejects.toThrow('图片在检查后被清理');
    s.copy.pages[0].jobs = [job('remote')];
    const translated = await planExport('样本', entries, {...options, images: 'translation'}, s.get, 'alice', 'https://api.example');
    let current = true;
    const download = vi.fn(async () => { current = false; return new Blob(['must not export']); });
    await expect(writeExport(translated, {...deps, download, isCurrent: () => current}, new AbortController().signal)).rejects.toThrow('账户或服务');
    expect(download).toHaveBeenCalledOnce();
  });
});
