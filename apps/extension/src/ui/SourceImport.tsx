import { useRef, useState } from 'react';
import { msg } from '../i18n/runtime';
import type { ImportAssignment, LibraryViewModel } from '../comics/application/types';
import { importManifest } from '../comics/application/import-service';
import { queueDownloads, runDownloads } from '../comics/acquisition';
import { initialChoices, selectManifest, imageOrigins, requestImagePermissions, type PageManifest } from '../sources';
import { Modal } from './components';
import { ImportAssignmentFields } from './ImportAssignment';
import { SourceImagePicker } from './SourceImagePicker';

interface Props { manifest: PageManifest; library: LibraryViewModel; onClose(): void; onDone(id?: string): void; onNotice?(message: string): void }
export function SourceImport({ manifest, library, onClose, onDone, onNotice }: Props) {
  const [choices, setChoices] = useState(() => initialChoices(manifest));
  const [assignment, setAssignment] = useState<ImportAssignment>({ title: manifest.title, kind: 'unclassified' });
  const [title, setTitle] = useState(manifest.title), [download, setDownload] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false), selected = choices.filter(item => item.selected);
  const valid = !!selected.length && !!title.trim() && (!!assignment.workId || !!assignment.title.trim());
  async function submit() {
    if (!valid || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      // The permission prompt remains directly inside the user click, before any catalog await.
      if (download) await requestImagePermissions(imageOrigins(selected.filter(item => item.kind !== 'page').map(item => item.url)));
      const chosen = selectManifest(manifest, selected.map(item => item.id));
      const fixed = { ...chosen, title: title.trim(), selectionConfirmed: true, discoveryComplete: true, knownTotal: chosen.items.length };
      const id = await importManifest(fixed, assignment);
      if (download) { await queueDownloads([id]); void runDownloads().catch(error => onNotice?.(error instanceof Error ? error.message : '下载未能启动。')); }
      onDone(id); onClose();
      onNotice?.(download ? `已加入 ${selected.length} 页图集，原图下载已排队。` : `已加入 ${selected.length} 页图集，阅读时按需获取原图。`);
    } catch (error) { setError(error instanceof Error ? error.message : '导入失败，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <Modal title={msg('加入漫画')} subtitle={msg('{0} · 已选 {1} 张', { '0': manifest.title, '1': selected.length })} onClose={() => { if (!busy) onClose(); }}>
    {error && <p role="alert" className="error-message">{error}</p>}
    <fieldset className="nc-web-import" disabled={busy}>
      <details open={!manifest.selectionConfirmed}><summary>{msg('查看图片与阅读顺序 · {0} 张', { '0': selected.length })}</summary><SourceImagePicker choices={choices} onChange={setChoices} disabled={busy} /></details>
      <ImportAssignmentFields value={assignment} onChange={setAssignment} library={library}/>
      <label className="field">{msg('副本／新条目名称')}<input value={title} onChange={event => setTitle(event.target.value)} maxLength={180} /></label>
      <label className="check-row"><input type="checkbox" checked={download} onChange={event => setDownload(event.target.checked)} />下载并保留所选原图</label>
      <p className="nc-muted">仅加入所选 {selected.length} 张图片，保留当前顺序；不代表完整章节。未下载页面在阅读时按需获取。翻译在阅读器中按需开始。</p>
      <button type="button" className="button primary full" disabled={!valid || busy} onClick={() => void submit()}>{busy ? msg('正在保存到书架…') : msg('加入漫画')}</button>
    </fieldset>
  </Modal>;
}
