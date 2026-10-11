import { ApiError } from '../src/lib/auth-session';
import type { DocumentTask } from '../src/lib/document-api';
export { ApiError };
const params = new URLSearchParams(location.search), changes = new EventTarget();
let version = 1, signedIn = params.get('scenario') !== 'signed-out';
const observations: { method: string; path: string; bytes?: number; account: number; at_ms: number }[] = [];
let inFlight = 0, maxInFlight = 0;
const metrics = { selectionPaintMs: 0, longTasks: 0, maxLongTaskMs: 0, heapAtSelection: 0, heapNow: 0 };
const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
const report = () => { const output = document.getElementById('document-observation'); if (output) output.textContent = JSON.stringify({ observations, maxInFlight, metrics: { ...metrics, heapNow: heap() } }, null, 2); };
const record = (method: string, path: string, bytes?: number) => { observations.push({ method, path, bytes, account: version, at_ms: Math.round(performance.now()) }); if (observations.length > 300) observations.shift(); report(); };
export function measureSelection(start: number) { metrics.heapAtSelection = heap(); requestAnimationFrame(() => requestAnimationFrame(() => { metrics.selectionPaintMs = Math.round(performance.now() - start); report(); })); }
if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
  for (const entry of list.getEntries()) { metrics.longTasks++; metrics.maxLongTaskMs = Math.max(metrics.maxLongTaskMs, Math.round(entry.duration)); }
}).observe({ type: 'longtask' });
export const sessionIdentity = async () => signedIn ? { id: 'document-session-' + version, subject: 'fixture-' + version } : null;
export const subscribeAuth = (listener: () => void) => { changes.addEventListener('change', listener); return () => changes.removeEventListener('change', listener); };
export const assertSession = async (id: string) => { if (!signedIn || id !== 'document-session-' + version) throw new ApiError('Fixture account changed', 401); };
export const signIn = async () => { signedIn = true; changes.dispatchEvent(new Event('change')); };
export const switchAccount = () => { version++; signedIn = true; changes.dispatchEvent(new Event('change')); };
export const signOut = () => { signedIn = false; changes.dispatchEvent(new Event('change')); };
const base: DocumentTask = { id: '11111111-1111-4111-8111-111111111111', filename: '漫画合集-200页.pdf', source_type: 'pdf', byte_size: 200_000_000,
  page_count: 200, model: { id: 'doc-model', name: 'Document Model' }, target_language: 'zh-Hans', status: 'awaiting_quota', phase: 'awaiting_quota', version: 1,
  progress: { pending: 200 }, quota: { needed: 200, available: 180, difference: 20, checked_at: '2026-10-11T10:00:00Z', reserved: 0, used: 0, released: 0 },
  cancellable: true, resumable: true, downloadable: false, error_code: 'DOCUMENT_QUOTA_INSUFFICIENT', created_at: '2026-10-11T10:00:00Z', expires_at: '2099-01-01T00:00:00Z', upload: null };
const seed = () => ['empty', 'signed-out', 'free'].includes(params.get('scenario') ?? '') ? [] : [base,
  { ...base, id: '22222222-2222-4222-8222-222222222222', filename: '夜航・Chapter_02.cbz', source_type: 'zip', status: 'running', phase: 'doc_ocr', cancellable: false, resumable: false, error_code: null,
    quota: { ...base.quota, reserved: 200, difference: 0 }, progress: { pending: 82, ocr_done: 118 } },
  { ...base, id: '33333333-3333-4333-8333-333333333333', filename: 'Translated sample.zip', source_type: 'zip', status: 'succeeded', phase: 'succeeded', cancellable: false, resumable: false, downloadable: true, error_code: null,
    quota: { ...base.quota, used: 198, released: 2, difference: 0 } },
] as DocumentTask[];
const key = () => 'document-fixture:' + (params.get('scenario') ?? '') + ':' + (params.get('run') ?? '') + ':' + version;
function rows(): DocumentTask[] { const raw = sessionStorage.getItem(key()); return raw ? JSON.parse(raw) : version === 1 ? seed() : []; }
function save(items: DocumentTask[]) { sessionStorage.setItem(key(), JSON.stringify(items)); }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const imageCapabilities = () => ({ result_protocol: 'overlay-v1', representations: ['overlay-v1'],
  limits: { max_bytes: 32 * 1024 * 1024, max_dimension: 8192, max_pixels: 40_000_000 },
  modes: [{ id: 'classic', enabled: true, languages: ['zh-Hans', 'en', 'zh-Hant'] }],
  languages: [{ id: 'zh-Hans', label: '简体中文' }, { id: 'en', label: 'English' }, { id: 'zh-Hant', label: '繁體中文' }],
  translation_models: [{ ...base.model, requires_paid: true, available: true }, { id: 'image-only', name: 'Image-only model', requires_paid: false, available: true }],
  entitlements: { modes: { classic: { allowed: true, unlimited: false, quota: { available: 180 } } } },
});
const imageTasks = new Map<string, { id: string; state: string; image: { sha256: string }; result?: unknown }>();
function delay(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function authenticatedFetch(path: string, options: RequestInit, identity: { id: string }) {
  await assertSession(identity.id); record(options.method ?? 'GET', path);
  await delay(80, options.signal); await assertSession(identity.id);
  if (path === '/v1/me') return json({ user: { id: 'fixture-' + version, name: '本地测试账户 ' + version } });
  if (path === '/v1/capabilities') return json(imageCapabilities());
  const imageMatch = path.match(/^\/v1\/translations\/([a-f0-9-]+)(?:\/(input))?$/);
  if (imageMatch) {
    const [, id, operation] = imageMatch, key = version + ':' + id;
    let task = imageTasks.get(key);
    if (!operation && options.method === 'PUT') {
      if (!task) { task = { ...JSON.parse(String(options.body)), id, state: 'needs_input' }; imageTasks.set(key, task!); }
      return json(task);
    }
    if (!task) return json({ error: { code: 'NOT_FOUND' } }, 404);
    if (operation === 'input') {
      const bitmap = await createImageBitmap(options.body as Blob);
      task.state = 'succeeded'; task.result = { kind: 'no_text', representation: 'original', input_sha256: task.image.sha256, normalization_version: 1, width: bitmap.width, height: bitmap.height };
      bitmap.close();
    }
    return json(task);
  }
  if (path === '/v1/documents/capabilities') return json({ enabled: params.get('scenario') !== 'disabled',
    limits: { max_bytes: 200_000_000, max_pages: 200, part_bytes: 16 * 1024 * 1024, waiting_hours: 24 }, languages: [{ id: 'zh-Hans', label: '简体中文' }, { id: 'en', label: 'English' }, { id: 'zh-Hant', label: '繁體中文' }], models: params.get('scenario') === 'no-models' ? [] : [base.model] });
  if (path.startsWith('/v1/documents?')) return json({ items: rows(), next_cursor: null });
  const match = path.match(/^\/v1\/documents\/([a-f0-9-]+)(?:\/(.+))?$/);
  if (!match) throw Error('No external API is allowed in this fixture');
  const [, id, operation] = match, items = rows();
  let row = items.find(item => item.id === id);
  if (options.method === 'PUT') {
    if (!row) {
      const body = JSON.parse(String(options.body));
      row = { ...base, ...body, id, status: 'uploading', phase: 'uploading', page_count: null, resumable: false,
        created_at: new Date().toISOString(), quota: { ...base.quota, needed: null, available: null, difference: null }, error_code: null, upload: { part_bytes: 16 * 1024 * 1024, part_count: Math.ceil(body.byte_size / (16 * 1024 * 1024)) } };
      items.unshift(row!); save(items);
    }
    return json(row, 202);
  }
  if (!row) return json({ error: { code: 'DOCUMENT_NOT_FOUND' } }, 404);
  if (operation === 'upload-parts') return json({ parts: JSON.parse(String(options.body)).part_numbers.map((part: number) => ({ part_number: part, url: `https://document-r2.fixture.invalid/${id}/${part}`, headers: {}, expires_in: 300 })) });
  if (operation === 'download') return json({ url: 'https://document-r2.fixture.invalid/result.zip' });
  if (operation === 'cancel') {
    if (!row.cancellable) return json({ error: { code: 'DOCUMENT_NOT_CANCELLABLE' } }, 409);
    Object.assign(row, { status: 'cancelled', phase: 'cancelled', cancellable: false, resumable: false });
  }
  if (operation === 'complete-upload' || operation === 'resume') Object.assign(row, {
    status: 'queued', phase: 'doc_ocr', page_count: 200, cancellable: false, resumable: false, upload: null, error_code: null,
    quota: { ...row.quota, reserved: 200, needed: 200, difference: 0 },
  });
  row.version++; save(items);
  if (operation === 'complete-upload' && params.has('fail-once') && !sessionStorage.getItem(key() + ':failed-seal')) {
    sessionStorage.setItem(key() + ':failed-seal', 'true'); throw new TypeError('Simulated lost sealing response');
  }
  return json(row);
}
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options) => {
  const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (path === '/v1/guest/session') { record('GET', path); return json({ enabled: false, site_key: '', user_id: null, daily_limit: 5, remaining: 5 }); }
  if (path === '/v1/capabilities') { record('GET', path); return json(imageCapabilities()); }
  if (path.startsWith('https://document-r2.fixture.invalid/')) {
    if (new Headers(options?.headers).has('Authorization') || options?.credentials !== 'omit') throw Error('Credentials reached object storage');
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    record('R2 PUT', new URL(path).pathname, (options?.body as Blob).size);
    try { await delay(params.has('slow') ? 5000 : 400, options?.signal); return new Response(null, { status: 200 }); }
    finally { inFlight--; report(); }
  }
  if (new URL(path, location.href).origin !== location.origin) throw Error('No external traffic is allowed in this fixture');
  return nativeFetch(input, options);
};
document.addEventListener('click', event => {
  const anchor = (event.target as Element)?.closest?.('a');
  if (anchor?.href.startsWith('https://document-r2.fixture.invalid/')) { event.preventDefault(); record('DOWNLOAD LINK', new URL(anchor.href).pathname); }
});
