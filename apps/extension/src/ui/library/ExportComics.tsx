import {useEffect, useMemo, useRef, useState} from 'react';
import type {Api} from '../../api';
import type {ReadingCopy, Settings} from '../../types';
import {languageLabel, modeLabels} from '../../types';
import type {ComicWork, LibraryState} from '../../library/types';
import {translationSummaries} from '../../library/translations';
import {getBlob} from '../../library/store';
import {countPages, exportCopies, MAX_EXPORT_BYTES, planExport, type ExportOptions, type ExportPlan} from '../../export/plan';
import type {ExportProgress} from '../../export/files';
import {Modal} from '../components';
import {Icon} from '../../icons';
import './export-comics.css';

interface Props {work: ComicWork; library: LibraryState; copies: ReadingCopy[]; settings: Settings; api?: Api; userId?: string; apiOrigin?: string; onClose: () => void;}
const sizeLabel = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MiB';

export function ExportComics({work, library, copies, settings, api, userId, apiOrigin, onClose}: Props) {
  const entries = useMemo(() => exportCopies(library, copies, work.id), [library, copies, work.id]);
  const [selected, setSelected] = useState(() => new Set(entries.filter(e => e.copy.pages.length && !e.otherWorks.length).map(e => e.copy.id)));
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<ExportOptions>({format: 'cbz', images: userId ? 'both' : 'original', mode: settings.translationMode, language: settings.language});
  const [plan, setPlan] = useState<ExportPlan>();
  const [incomplete, setIncomplete] = useState(false), [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [progress, setProgress] = useState<ExportProgress>();
  const [result, setResult] = useState<{url: string; name: string; size: number}>();
  const operation = useRef<AbortController | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const identity = userId + ':' + apiOrigin;
  const current = useRef(identity); current.current = identity;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  useEffect(() => { return () => { operation.current?.abort(); }; }, [identity, api]);
  useEffect(() => { setPlan(undefined); setResult(undefined); setShared(false); setIncomplete(false); if (!userId) setOptions(value => ({...value, images: 'original'})); }, [identity, api, userId]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  useEffect(() => { const dialog = container.current?.closest('dialog'); if (dialog) dialog.scrollTop = 0; }, [!!plan]);
  const visible = entries.filter(e => (e.copy.title + e.copy.source + e.group + e.coverage.join(' ')).toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(visible.map(e => e.groupKey))];
  const chosen = entries.filter(e => selected.has(e.copy.id));
  const languages = [...new Set([settings.language, options.language, ...chosen.flatMap(e => translationSummaries(e.copy, userId, apiOrigin).map(s => s.language))])];
  const reset = () => { setPlan(undefined); setResult(undefined); setError(''); setIncomplete(false); setShared(false); };
  const updateOptions = (patch: Partial<ExportOptions>) => { reset(); setOptions(value => ({...value, ...patch})); };
  const toggle = (id: string) => { reset(); setSelected(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }); };
  const valid = (controller: AbortController) => mounted.current && !controller.signal.aborted && current.current === identity && (!api || api.isCurrent());
  async function inspect() {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    reset(); setBusy('正在检查本机图片');
    try {
      const value = await planExport(work.title, chosen, options, getBlob, userId, apiOrigin, controller.signal);
      if (valid(controller)) setPlan(value);
    } catch (reason) { if (valid(controller)) setError(reason instanceof Error ? reason.message : '检查失败，请重试。'); }
    finally { if (operation.current === controller) operation.current = undefined; if (mounted.current) setBusy(''); }
  }
  async function generate() {
    if (!plan || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy('正在导出漫画'); setError(''); setResult(undefined); setProgress(undefined);
    try {
      const {writeExport} = await import('../../export/files');
      const output = await writeExport(plan, {getBlob, download: (id, signal) => {
        if (!api || !userId) throw Error('请登录后下载已有译图。');
        return api.image(id, signal);
      }, isCurrent: () => valid(controller), progress: value => { if (valid(controller)) setProgress(value); }}, controller.signal, incomplete, shared);
      if (valid(controller)) setResult({url: URL.createObjectURL(output.blob), name: output.name, size: output.blob.size});
    } catch (reason) { if (valid(controller)) setError(reason instanceof Error ? reason.message : '导出失败，请重试。'); }
    finally { if (operation.current === controller) operation.current = undefined; if (mounted.current) setBusy(''); }
  }
  const cancel = () => { operation.current?.abort(); setError('已取消，未生成下载文件。'); };
  const blocked = !plan || plan.books.some(b => b.pages.every(p => p.kind === 'missing')) || plan.localBytes > MAX_EXPORT_BYTES
    || plan.books.some(b => b.incomplete) && !incomplete || plan.books.some(b => b.otherWorks.length) && !shared;
  return <Modal title="导出漫画" subtitle={work.title + ' · 每份副本独立成册，多个文件打包下载'} onClose={() => { operation.current?.abort(); onClose(); }}>
    <div className="nc-export" ref={container}>
      <ol className="nc-export-steps"><li aria-current={!plan ? 'step' : undefined}><span>1</span>选择内容</li><li aria-current={plan ? 'step' : undefined}><span>2</span>检查与导出</li></ol>
      <fieldset disabled={!!busy} className="nc-export-options" hidden={!!plan}>
        <div className="nc-form-grid">
          <label className="field">导出格式<select aria-label="导出格式" value={options.format} onChange={e => updateOptions({format: e.target.value as ExportOptions['format']})}><option value="cbz">CBZ · 漫画阅读器</option><option value="zip">图片 ZIP · 原始图片目录</option><option value="pdf">PDF · 通用阅读</option></select></label>
          <label className="field">导出图片<select aria-label="导出图片" value={options.images} onChange={e => updateOptions({images: e.target.value as ExportOptions['images']})}><option value="original">仅原图</option><option value="translation" disabled={!userId}>仅译图</option><option value="both" disabled={!userId}>原图与译图 · 分开成册</option></select></label>
          {options.images !== 'original' && <><label className="field">翻译模式<select aria-label="翻译模式" value={options.mode} onChange={e => updateOptions({mode: e.target.value as ExportOptions['mode']})}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field">译图语言<select aria-label="译图语言" value={options.language} onChange={e => updateOptions({language: e.target.value})}>{languages.map(value => <option key={value} value={value}>{languageLabel(value)}</option>)}</select></label></>}
        </div>
        <p className="nc-export-hint">{options.images !== 'original' ? '每页使用最新成功译图；缺少译图时用原图补齐，已有服务端译图会下载。' : '导出已保存在本机的原图。登录后可选择当前账户的译图。'}</p>
        <p className="nc-export-hint">{options.format === 'pdf' ? 'PDF 保持图片比例，一页一图，以 95% 质量 JPEG 编码；单份 PDF 图片上限 128 MiB。' : 'CBZ / ZIP 保留 JPEG、PNG、WebP 原始图片字节；其他图片转为 PNG。'} 每次导出上限 512 MiB，大部作品请分批选择。</p>
        <div className="nc-export-selection-heading"><strong>选择副本 <span>{chosen.length} / {entries.length}</span></strong><button className="text-link" onClick={() => { reset(); setSelected(new Set()); }}>清空选择</button></div>
        <label className="nc-search"><Icon name="book" size={18}/><input type="search" aria-label="搜索导出副本" placeholder="搜索章节、卷册或来源" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <div className="nc-export-copies">
          {groups.map(key => {
            const items = visible.filter(e => e.groupKey === key);
            return <section key={key}><div className="nc-export-group-heading"><h3>{items[0].group}</h3><button className="text-link" onClick={() => { reset(); setSelected(previous => new Set([...previous, ...items.filter(e => e.copy.pages.length).map(e => e.copy.id)])); }}>全选此组</button></div>
              {items.map(({copy, coverage, otherWorks}) => <label className={'nc-export-copy ' + (selected.has(copy.id) ? 'is-selected' : '')} key={copy.id}>
                <input type="checkbox" checked={selected.has(copy.id)} disabled={!copy.pages.length} onChange={() => toggle(copy.id)}/>
                <span><strong>{copy.title}</strong><small>{copy.source} · 修订 {copy.manifestRevision} · {copy.pages.filter(p => p.blobKey).length} / {copy.knownTotal ?? (copy.discoveryComplete ? copy.pages.length : '?')} 页本机原图</small>
                  <small>{coverage.join('、')}{copy.versionId ? ' · ' + (library.versions.find(v => v.id === copy.versionId)?.title ?? '内容版本') : ''}</small>
                  {!!otherWorks.length && <small className="nc-export-warning">整份副本还包含：{otherWorks.join('、')}</small>}
                </span>
              </label>)}
            </section>;
          })}
          {!visible.length && <p className="nc-export-empty">{entries.length ? '没有匹配的副本。' : '当前作品尚无可导出副本，请先导入或采集漫画。'}</p>}
        </div>
      </fieldset>
      {plan && <section className="nc-export-preview" aria-label="导出清单">
        <div className="nc-export-selection-heading"><h3>导出清单 · {plan.options.format.toUpperCase()}</h3><span>{plan.books.length} {plan.options.format === 'zip' ? '组图片' : '个文件'} · 本机图片 {sizeLabel(plan.localBytes)}</span></div>
        {plan.localBytes > MAX_EXPORT_BYTES && <p className="nc-export-warning" role="alert">已超过 512 MiB，请减少所选副本后重新检查。</p>}
        {plan.books.some(b => b.pages.every(p => p.kind === 'missing')) && <p className="nc-export-warning" role="alert">有文件没有可导出图片，请返回选择并取消对应副本，或调整原图／译图选项。</p>}
        <div className="nc-export-book-list">{plan.books.map(book => <details key={book.path} className="nc-export-book"><summary><span><b>{book.title} · {book.edition}</b><small>{book.pages.length - countPages(book, 'missing')} / {book.total ?? '?'} 页可导出 · {countPages(book, 'translation')} 页译图 · {countPages(book, 'fallback')} 页补原图{countPages(book, 'no_text') > 0 ? ' · ' + countPages(book, 'no_text') + ' 页无文字' : ''}</small></span>{book.incomplete && <em>不完整</em>}</summary>
          <p className="nc-export-path">{book.path}{options.format === 'zip' ? '/' : '.' + options.format}</p>
          {book.pages.some(p => p.assetId) && <p className="nc-export-hint">{book.pages.filter(p => p.assetId).length} 页译图待从服务器下载；开始导出时核实可用性。</p>}
          {!book.pages.some(p => p.kind !== 'missing') && <p className="nc-export-warning">没有可导出图片，请取消选择该副本或调整图片选项。</p>}
          {book.incomplete && <p className="nc-export-warning">缺失 {countPages(book, 'missing')} 个已知页面槽位；{book.total === undefined ? '总页数尚未确认。' : `已发现 ${book.pages.length} / ${book.total} 页。`}</p>}
          <ul>{book.pages.filter(p => p.reason).map(p => <li key={p.id}>第 {p.ordinal} 页：{p.kind === 'missing' ? '缺页' : p.kind === 'no_text' ? '无文字，保留原图' : '使用原图'} · {p.reason}</li>)}</ul>
        </details>)}</div>
        <fieldset disabled={!!busy} className="nc-export-options nc-export-consents">
          {plan.books.some(b => b.incomplete) && <label><input type="checkbox" checked={incomplete} onChange={e => setIncomplete(e.target.checked)}/>允许导出不完整内容：跳过缺失图片，保留原页序号并在文件名中标注。</label>}
          {plan.books.some(b => b.otherWorks.length) && <label><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)}/>按整份副本导出，包含已提示的其他作品；不按章节收录关系拆页。</label>}
        </fieldset>
        <p className="nc-export-hint">清单按检查时的页面及译图版本生成；新采集或新翻译的内容可重新检查后加入。导出说明记录每页来源与缺页情况。</p>
      </section>}
      {busy && <div className="nc-export-progress" role="status"><strong><span className="spinner"/>{busy}</strong>{progress && <><progress max={progress.total} value={progress.completed}/><span>{progress.file} · {progress.phase} · {progress.completed} / {progress.total}</span></>}</div>}
      {error && <p className="nc-action-feedback error" role="alert">{error}</p>}
      {result && <div className="nc-export-result" role="status"><Icon name="check"/><span><strong>文件已生成 · {sizeLabel(result.size)}</strong><small>{result.name}</small></span><a className="button primary" href={result.url} download={result.name}>下载文件</a></div>}
      <div className="nc-modal-footer">
        {busy ? <button className="button secondary" onClick={cancel}>取消导出</button> : <><button className="button secondary" onClick={plan ? reset : onClose}>{plan ? '返回选择' : '关闭'}</button><button className={'button ' + (plan ? 'secondary' : 'primary')} disabled={!chosen.length} onClick={() => void inspect()}>{plan ? '重新检查清单' : '检查导出清单'}</button>{plan && <button className="button primary" disabled={blocked} onClick={() => void generate()}>{result ? '重新生成' : '开始导出'}</button>}</>}
      </div>
    </div>
  </Modal>;
}
