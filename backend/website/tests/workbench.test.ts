import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitWorkbenchFiles, workbenchModels } from '../src/lib/workbench-files';
import { workbenchCopy } from '../src/i18n/workbench';
import { translationCopy } from '../src/i18n/translate';
import { documentCopy, documentError } from '../src/i18n/documents';
import { translationCacheCopy } from '../src/i18n/translation-cache';
import { locales } from '../src/i18n/locales';
import type { DocumentCapabilities, DocumentTask } from '../src/lib/document-api';
import DocumentTaskRow from '../src/components/DocumentTaskRow';

test('one input routes mixed files by metadata without reading or copying any Blob', () => {
  const image = new File(['png'], 'page.png', { type: 'image/png' }), pdf = new File(['pdf'], 'BOOK.PDF');
  const cbz = new File(['zip'], 'book.cbz'), bad = new File(['bad'], 'bad.pdf.exe');
  for (const file of [image, pdf, cbz, bad]) {
    file.arrayBuffer = () => { throw Error('Must not read on selection'); };
    file.slice = () => { throw Error('Must not copy on selection'); };
  }
  const result = splitWorkbenchFiles([image, pdf, cbz, bad]);
  assert.deepEqual(result, { images: [image, bad], documents: [pdf, cbz] });
  assert.equal(result.documents[0], pdf);
});

test('mixed submissions only offer models allowed by both APIs; image-only choices stay unchanged', () => {
  const images = [{ id: 'image', name: 'Image', requires_paid: false, available: true }, { id: 'both', name: 'Both', requires_paid: true, available: true }];
  const caps = { enabled: true, paid_allowed: true, models: [{ id: 'both', name: 'Both' }, { id: 'doc', name: 'Document' }] } as DocumentCapabilities;
  assert.equal(workbenchModels(images, caps, true, false), images);
  assert.deepEqual(workbenchModels(images, caps, true, true)?.map(item => item.available), [true, false]);
  assert.deepEqual(workbenchModels(images, caps, false, true)?.map(item => item.available), [true, true]);
  assert.ok(workbenchModels(images, { ...caps, enabled: false }, false, true)?.every(item => !item.available));
  assert.ok(workbenchModels(images, { ...caps, paid_allowed: false }, false, true)?.every(item => !item.available));
});

const row: DocumentTask = { id: 'one', filename: 'book.pdf', status: 'running', phase: 'doc_ocr', version: 1,
  source_type: 'pdf', byte_size: 200_000_000, page_count: 200, target_language: 'zh-Hans', model: { id: 'both', name: 'Both' },
  progress: { ocr_done: 120, no_text: 2 }, quota: { reserved: 200, used: 0, released: 0, needed: 200, available: 0, difference: 0, checked_at: null },
  cancellable: false, resumable: false, downloadable: false, error_code: null, created_at: '2026-10-11T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', upload: null };
const render = (task: DocumentTask) => renderToStaticMarkup(createElement(DocumentTaskRow, { row: task, locale: 'zh-CN', disabled: false, onAction: () => {} }));
test('document row trusts server action flags, not a client-inferred cancellation state', () => {
  for (const status of ['queued', 'running', 'outcome_unknown', 'succeeded'] as const) assert.doesNotMatch(render({ ...row, status }), /<button/);
  const waiting = render({ ...row, status: 'awaiting_quota', cancellable: true, resumable: true });
  assert.match(waiting, />取消<\/button>/); assert.match(waiting, /补充额度后继续/);
  const done = render({ ...row, status: 'succeeded', downloadable: true });
  assert.match(done, /下载译图 ZIP/); assert.doesNotMatch(done, />取消<\/button>/);
  assert.doesNotMatch(render({ ...row, status: 'succeeded', downloadable: true, expires_at: '2020-01-01T00:00:00Z' }), /<button/);
  assert.match(render(row), /122\/200 页/);
});
test('all site locales have complete unified copy and preserve file limits', () => {
  for (const locale of locales) {
    assert.deepEqual(Object.keys(workbenchCopy[locale]), Object.keys(workbenchCopy.en));
    assert.ok(Object.values(workbenchCopy[locale]).every(value => typeof value === 'string' && value.length > 0), locale);
    assert.match(workbenchCopy[locale].documentHint, /200/);
    assert.match(workbenchCopy[locale].downloadImages, /ZIP/);
  }
});
test('production mounts only one workbench and lazily loads the original document transport', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const page = read('../src/components/TranslatePage.astro'), hook = read('../src/lib/use-document-tasks.ts');
  assert.equal((page.match(/client:load/g) ?? []).length, 1);
  assert.doesNotMatch(page, /DocumentWorkbench|translation-kind-nav/);
  assert.match(hook, /import\('\.\/document-api'\)/);
  assert.match(hook, /\?limit=20/);
  assert.match(hook, /setTimeout\(\(\) => \{ void read\(\); \}, 5000\)/);
  assert.doesNotMatch(hook, /setInterval|sessionIdentity|subscribeAuth|indexedDB|arrayBuffer|unzip|pdfjs/);
  assert.match(hook, /const receipt = !working\.current && draft\.current/);
  assert.match(hook, /row\.status !== 'uploading'/);
});

test('retired panels, styles and duplicate copy are not retained as compatibility paths', () => {
  for (const path of ['components/DocumentWorkbench.tsx', 'components/ImageDropzone.tsx', 'styles/document.css'])
    assert.equal(existsSync(new URL('../src/' + path, import.meta.url)), false, path);
  const styles = ['controls', 'translate'].map(name => readFileSync(new URL('../src/styles/' + name + '.css', import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(styles, /image-dropzone|document-settings|translation-kind-nav|translation-records li > button/);
  const dropzone = readFileSync(new URL('../src/components/FileDropzone.tsx', import.meta.url), 'utf8');
  assert.match(dropzone, /await onFiles\(files\)/);
  assert.doesNotMatch(dropzone, /importImages|localPath|onAdded|translationCopy/);
  for (const locale of locales) {
    for (const key of ['title', 'intro', 'select', 'drop', 'newImages', 'files', 'downloadAll', 'uploadTitle', 'historyEmpty', 'localTitle', 'serverTitle'])
      assert.equal(key in translationCopy[locale], false, locale + ':' + key);
    for (const key of ['navImage', 'navDocument', 'title', 'intro', 'login', 'choose', 'language', 'model', 'upload', 'historyHint', 'empty'])
      assert.equal(key in documentCopy(locale), false, locale + ':' + key);
    assert.equal('clear' in translationCacheCopy[locale], false);
    const copy = documentCopy(locale);
    assert.ok(copy.errors.model);
    assert.equal(documentError('DOCUMENT_MODEL_UNAVAILABLE', copy), copy.errors.model);
  }
});
