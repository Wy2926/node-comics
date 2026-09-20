import {msg} from '../i18n/runtime';
import {BlobReader, BlobWriter, TextReader, ZipWriter} from '@zip.js/zip.js/index-native.js';
import {exportImage} from './images';
import {exportManifest, MAX_EXPORT_BYTES, safeName, type ExportPlan} from './plan';

export interface ExportProgress {completed: number; total: number; file: string; phase: string;}
export interface ExportDependencies {
  getBlob: (key: string) => Promise<Blob | undefined>;
  download: (assetId: string, signal: AbortSignal) => Promise<Blob>;
  isCurrent: () => boolean;
  progress: (value: ExportProgress) => void;
}

export async function writeExport(plan: ExportPlan, dependencies: ExportDependencies, signal: AbortSignal,
  allowIncomplete = false, allowShared = false): Promise<{blob: Blob; name: string}> {
  const {getBlob, download, progress} = dependencies;
  const check = () => { signal.throwIfAborted(); if (!dependencies.isCurrent()) throw Error(msg("账户或服务已切换，本次导出已停止。")); };
  check();
  if (!plan.books.length) throw Error(msg("没有可导出的文件。"));
  if (plan.books.some(b => b.incomplete) && !allowIncomplete) throw Error(msg("所选内容尚不完整，请检查缺页并选择是否导出已保存部分。"));
  if (plan.books.some(b => b.otherWorks.length) && !allowShared) throw Error(msg("所选副本还包含其他作品，请确认整份副本的导出范围。"));
  const empty = plan.books.find(b => b.pages.every(p => p.kind === 'missing'));
  if (empty) throw Error(msg("「{0} · {1}」没有可导出图片，请取消选择该副本或调整图片选项。", {"0": empty.title, "1": empty.edition}));
  if (plan.localBytes > MAX_EXPORT_BYTES) throw Error(msg("本次图片超过 512 MiB，请分批选择副本导出。"));
  const format = plan.options.format;
  const total = plan.books.reduce((n, b) => n + b.pages.filter(p => p.kind !== 'missing').length, 0);
  let completed = 0, sourceBytes = 0, outputBytes = 0;
  const newZip = () => new ZipWriter(new BlobWriter('application/zip'), {useWebWorkers: false, useCompressionStream: true, level: 0});
  const bundled = format === 'zip' || plan.books.length > 1;
  const outer = bundled ? newZip() : undefined;
  let single: Blob | undefined;
  for (const book of plan.books) {
    check();
    const pdf = format === 'pdf' ? await (await import('./pdf')).pdfWriter(book.title + ' · ' + book.edition) : undefined;
    const zip = format === 'cbz' ? newZip() : undefined;
    for (const page of book.pages) {
      if (page.kind === 'missing') continue;
      check();
      progress({completed, total, file: book.title + ' · ' + book.edition, phase: msg("读取第 {0} 页", {"0": page.ordinal})});
      try {
        let blob = page.blobKey ? await getBlob(page.blobKey) : undefined;
        check();
        if (!blob && page.assetId) blob = await download(page.assetId, signal);
        check();
        if (!blob) throw Error(msg("图片在检查后被清理，请重新检查清单或补齐图片。"));
        sourceBytes += blob.size;
        if (sourceBytes > MAX_EXPORT_BYTES) throw Error(msg("本次图片超过 512 MiB，请分批导出。"));
        if (pdf) await pdf.add(blob);
        else {
          const image = await exportImage(blob);
          check();
          outputBytes += image.blob.size;
          if (outputBytes > MAX_EXPORT_BYTES) throw Error(msg("本次文件超过 512 MiB，请分批导出。"));
          const name = String(page.ordinal).padStart(5, '0') + '.' + image.extension;
          await (zip ?? outer)!.add(zip ? name : book.path + '/' + name, new BlobReader(image.blob), {signal});
        }
        check();
        completed++;
        progress({completed, total, file: book.title + ' · ' + book.edition, phase: msg("已处理第 {0} 页", {"0": page.ordinal})});
      } catch (error) {
        check();
        throw Error(msg("「{0} · {1}」第 {2} 页导出失败：{3}", {"0": book.title, "1": book.edition, "2": page.ordinal, "3": error instanceof Error ? error.message : msg("图片无法读取，请重试。")}));
      }
    }
    check();
    progress({completed, total, file: book.title + ' · ' + book.edition, phase: msg("正在封装文件")});
    const manifest = JSON.stringify(exportManifest(plan, [book]), null, 2);
    let result: Blob | undefined;
    if (pdf) result = await pdf.close(manifest);
    else if (zip) { await zip.add(msg("导出说明.json"), new TextReader(manifest), {signal}); result = await zip.close(); }
    if (result) {
      if (pdf) outputBytes += result.size;
      if (outputBytes > MAX_EXPORT_BYTES) throw Error(msg("本次文件超过 512 MiB，请分批导出。"));
      check();
      if (outer) await outer.add(book.path + '.' + format, new BlobReader(result), {signal});
      else single = result;
    }
  }
  check();
  if (outer) {
    await outer.add(msg("导出说明.json"), new TextReader(JSON.stringify(exportManifest(plan), null, 2)), {signal});
    single = await outer.close();
  }
  check();
  if (!single || single.size > MAX_EXPORT_BYTES) throw Error(msg("导出文件超过 512 MiB，请分批选择副本。"));
  const incomplete = plan.books.some(b => b.incomplete) ? msg("-不完整") : '';
  const name = bundled ? msg("{0}-导出{1}.zip", {"0": safeName(plan.title), "1": incomplete})
    : safeName(plan.title) + '-' + safeName(plan.books[0].title) + '-' + safeName(plan.books[0].edition) + incomplete + '.' + format;
  return {blob: single, name};
}
