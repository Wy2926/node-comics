import {useMemo, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Api} from '../src/api';
import {Library} from '../src/ui/Library';
import {attachCopy, makeCopy} from '../src/library/model';
import {emptyPage} from '../src/reader/model';
import {defaults, type Job} from '../src/types';
import * as store from '../src/library/store';
import '../src/styles.css';
import '../src/redesign.css';
import '../src/library.css';
import '../src/ui/theme/surfaces.css';

if (location.hostname !== '127.0.0.1' || location.port !== '5176') throw Error('导出验收仅允许独立的 127.0.0.1:5176 来源。');
const previous = await store.readLibrary();
if (previous.works.some(w => !w.title.startsWith('导出验收'))) throw Error('此来源有其他作品，停止写入验收数据。');
if (!previous.works.length) {
  for (const [n, color] of ['#ff486d', '#40b58b', '#427cdd', '#f0c244'].entries()) {
    const canvas = new OffscreenCanvas(360, 540), ctx = canvas.getContext('2d')!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 360, 540); ctx.fillStyle = 'white'; ctx.fillRect(28, 28, 304, 140);
    ctx.fillStyle = '#253047'; ctx.font = 'bold 36px sans-serif'; ctx.fillText(n === 3 ? 'TRANSLATED' : 'PAGE ' + (n + 1), 42, 105);
    await store.putBlob('export-fixture-' + n, await canvas.convertToBlob({type: n === 2 ? 'image/webp' : 'image/png'}));
  }
  await store.editLibrary((state, copies) => {
    const pages = [0, 1, 2].map(n => ({...emptyPage('原始页-' + n, 360, 540), blobKey: 'export-fixture-' + n, ownerId: 'fixture-owner', apiOrigin: 'http://127.0.0.1:18098'}));
    const job: Job = {id: 'fixture-translation', input_asset_id: 'fixture-input', output_asset_id: 'fixture-output', mode: 'classic', target_language: 'zh-Hans', status: 'succeeded', phase: 'done', version: 1, quota_pages: 0, cache_hit: false, created_at: '2026-09-15T00:00:00Z'};
    pages[0].jobs = [job]; pages[0].outputBlobs = {[job.id]: 'export-fixture-3'};
    pages[1].jobs = [{...job, id: 'fixture-no-text', output_asset_id: null, status: 'no_text'}];
    const copy = makeCopy('第 01 话 · 雨后的来信', pages, '原创样本'); copy.id = 'fixture-complete'; copy.pageId = pages[1].id; copy.relativeOffset = 0.42;
    const workId = attachCopy(state, copy, {title: '导出验收 · 星光书店', kind: 'chapter'}); copies.push(copy);
    const partial = makeCopy('第 02 话 · 未完成的旅程', pages.map((p, n) => ({...p, id: 'partial-' + n, blobKey: n === 0 ? p.blobKey : undefined, jobs: n === 1 ? [{...job, id: 'fixture-remote', output_asset_id: 'fixture-remote-output'}] : [], outputBlobs: {}})), '原创样本');
    partial.id = 'fixture-partial'; partial.sourceEntryId = 'fixture-source'; partial.discoveryComplete = false; partial.knownTotal = 4;
    attachCopy(state, partial, {workId, title: '导出验收 · 星光书店', kind: 'chapter'}); copies.push(partial);
    const shared = makeCopy('两部作品合订册', pages, '原创样本'); shared.id = 'fixture-shared';
    attachCopy(state, shared, {workId, title: '导出验收 · 星光书店', kind: 'publication'});
    attachCopy(state, shared, {title: '导出验收 · 海风日记', kind: 'work'}); copies.push(shared);
    const empty = makeCopy('待采集章节', [], '原创样本'); empty.id = 'fixture-empty';
    attachCopy(state, empty, {workId, title: '导出验收 · 星光书店', kind: 'chapter'}); copies.push(empty);
  });
}
const library = await store.readLibrary(), copies = await store.readCopies();
function Fixture() {
  const [userId, setUserId] = useState('fixture-owner');
  const api = useMemo(() => new Api('http://127.0.0.1:18098', 'fixture-only'), [userId]);
  return <div className="nc-app"><main className="nc-main"><button className="text-link" onClick={() => setUserId('other-account')}>切换验收账户</button><Library api={api} library={library} copies={copies} settings={defaults} setSettings={() => {}} userId={userId} apiOrigin={api.base} onOpen={() => {}} onOpenTranslation={() => {}} onImport={() => {}} onDemo={() => {}} onSource={() => {}} notify={() => {}} onChanged={() => {}}/></main></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
