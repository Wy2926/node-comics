import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';

const OPDS = 'application/opds+json';
const ACQUISITION = 'http://opds-spec.org/acquisition';
const titles = [
  '星灯书店', '风起海岸', '雨巷侦探', '月球邮差', '山间的咖啡馆', '离开城市以后，我们在森林里开了一间小小的书店',
  '云上旅人', '夜航日记', '银河慢车', '夏日列车', '小镇来信', '鲸落之后',
  '奇迹邮局', '黑猫与魔法师', '星海拾光', '千年图书馆', '远山回声', '纸上冒险',
  '小小宇宙', '晚风与橘子', '蓝色星期天', '四季物语', '最后一颗星', '借阅限定的秘密花园',
];
const palettes = [[38, 78, 105], [169, 93, 65], [58, 109, 101], [126, 95, 139], [180, 142, 57], [80, 103, 139]];

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, bytes: Uint8Array) {
  const body = Buffer.concat([Buffer.from(name), bytes]), header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
/** Small code-generated PNG covers keep the UI fixture independent of external artwork. */
export function cover(index: number) {
  const width = 240, height = 360, pixels = Buffer.alloc((width * 3 + 1) * height), color = palettes[index % palettes.length];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const circle = (x - 120) ** 2 + (y - 115) ** 2 < (55 + index % 4 * 7) ** 2;
    const horizon = y > 210 + Math.sin(x / 30 + index) * 24;
    const stripe = y > 295 && y < 304 || y > 315 && y < 319 && x > 48 && x < 192;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = stripe ? 238 : circle ? 220 - channel * 9 : Math.max(0, color[channel] - (horizon ? 25 : 0));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', new Uint8Array())]);
}
const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);

/** Real loopback HTTP catalog, image and file responses; no provider/service mocks. */
export async function remoteLibraryUiFixture() {
  const page = await readFile(new URL('../../../../samples/starlight-bookshop.png', import.meta.url));
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 });
  for (let ordinal = 0; ordinal < 3; ordinal++) await writer.add(`page-${ordinal + 1}.png`, new BlobReader(new Blob([page])));
  const archive = await writer.close(), covers = titles.map((_, index) => cover(index));
  const requests: { method: string; path: string; status: number }[] = [], failed = new Set<string>();
  function publication(root: string, index: number) {
    const title = titles[index], restricted = index === titles.length - 1;
    return {
      metadata: { title, author: [{ name: index % 2 ? '林间工作室' : '星野绘' }, ...(index % 4 === 0 ? [{ name: '青禾' }] : [])], description: `${title}：一段关于相遇、旅行与日常的原创测试故事。\n封面、简介与三页正文用于隔离界面验收，不调用翻译服务。` },
      links: restricted ? [
        { rel: 'self', href: `${root}/items/${index + 1}`, type: 'application/json' },
        { rel: ACQUISITION + '/borrow', href: `${root}/borrow/${index + 1}`, type: 'application/epub+zip' },
      ] : [
        { rel: 'self', href: `${root}/items/${index + 1}`, type: 'application/atom+xml;type=entry' },
        { rel: ACQUISITION, href: '/fixture-assets/book.cbz', type: 'application/vnd.comicbook+zip' },
      ],
      images: [{ href: index === 7 ? '/fixture-assets/missing-cover.png' : `/fixture-assets/covers/${index + 1}.png`, type: 'image/png' }],
    };
  }
  function feed(root: string, path: string, query: URLSearchParams) {
    const other = root === '/opds-other', title = other ? '林间书屋' : '星灯漫画馆';
    const pageNumber = query.get('page') === '2' ? 2 : 1;
    const links: Record<string, unknown>[] = [
      { rel: 'self', href: path + (query.size ? '?' + query.toString() : ''), type: OPDS },
    ];
    // Search results need not advertise search again; replacements must use the source catalog.
    if (path !== root + '/search') links.push({ rel: 'search', href: `${root}/search{?query}`, type: OPDS, templated: true });
    const navigation = (label: string, route: string) => ({ title: label, href: root + route, type: OPDS });
    if (path === root) return {
      metadata: { title }, links,
      navigation: [navigation('全部漫画', '/all'), navigation('冒险与奇幻', '/adventure'), navigation('日常与短篇', '/everyday'), navigation('重试测试', '/retry')],
      groups: [
        { metadata: { title: '精选推荐' }, links: [{ rel: 'self', href: root + '/all', type: OPDS }], publications: titles.slice(0, 8).map((_, index) => publication(root, index)) },
        { metadata: { title: '冒险与奇幻' }, links: [{ rel: 'self', href: root + '/adventure', type: OPDS }], publications: titles.slice(8, 16).map((_, index) => publication(root, index + 8)) },
        { metadata: { title: '日常与短篇' }, links: [{ rel: 'self', href: root + '/everyday', type: OPDS }], publications: titles.slice(16).map((_, index) => publication(root, index + 16)) },
      ],
    };
    let indices = titles.map((_, index) => index), pageTitle = '全部漫画';
    let categories: ReturnType<typeof navigation>[] = [];
    if (path === root + '/adventure') { indices = indices.slice(8, 16); pageTitle = '冒险与奇幻'; categories = [navigation('星海系列', '/adventure/stars')]; }
    else if (path === root + '/adventure/stars') { indices = [8, 14, 22]; pageTitle = '星海系列'; }
    else if (path === root + '/everyday') { indices = indices.slice(16); pageTitle = '日常与短篇'; categories = [navigation('空目录', '/everyday/empty')]; }
    else if (path === root + '/everyday/empty') { indices = []; pageTitle = '空目录'; }
    else if (path === root + '/retry') { indices = [0, 7]; pageTitle = '重试成功'; }
    else if (path === root + '/search') { const value = (query.get('query') ?? '').trim().toLowerCase(); indices = indices.filter((index) => titles[index].toLowerCase().includes(value)); pageTitle = `搜索：${value}`; }
    else if (path !== root + '/all') return;
    const size = 12, total = indices.length, selection = indices.slice((pageNumber - 1) * size, pageNumber * size);
    const cursor = (target: number) => { const next = new URLSearchParams(query); next.set('page', String(target)); return `${path}?${next}`; };
    if (pageNumber === 1 && total > size) links.push({ rel: 'next', href: cursor(2), type: OPDS });
    if (pageNumber === 2) links.push({ rel: 'previous', href: cursor(1), type: OPDS });
    return { metadata: { title: pageTitle }, links, navigation: categories, publications: selection.map((index) => publication(root, index)), facets: path === root + '/all' ? [
      { metadata: { title: '分类' }, links: [{ rel: 'self', title: '全部漫画', href: root + '/all', type: OPDS }, { title: '冒险与奇幻', href: root + '/adventure', type: OPDS }] },
    ] : [] };
  }
  function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'), path = url.pathname;
    const send = (status: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8') => {
      if (requests.length === 500) requests.shift();
      requests.push({ method: req.method ?? '', path: url.pathname + url.search, status });
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { send(405, 'Read-only fixture'); return; }
    if (path === '/__remote_ui_metrics') { send(200, JSON.stringify({ requests, retryFailures: [...failed] }), 'application/json'); return; }
    if (path === '/fixture-assets/book.cbz') { send(200, archive, 'application/vnd.comicbook+zip'); return; }
    const image = /^\/fixture-assets\/(covers|pages)\/(\d+)\.png$/.exec(path);
    if (image) {
      const index = Number(image[2]), bytes = image[1] === 'covers' ? covers[index - 1] : index >= 0 && index < 3 ? page : undefined;
      send(bytes ? 200 : 404, bytes ?? 'Missing image', bytes ? 'image/png' : undefined); return;
    }
    const root = /^\/opds(?:-other)?(?=\/|$)/.exec(path)?.[0];
    if (root) {
      if (path === root + '/retry' && !failed.has(root)) { failed.add(root); send(503, 'One-time fixture catalog failure'); return; }
      const item = new RegExp(`^${root}/items/(\\d+)$`).exec(path);
      if (item) {
        const index = Number(item[1]) - 1;
        if (index >= 0 && index < titles.length - 1) {
          const pub = publication(root, index);
          // OPDS 2 entry links to a standard Atom detail so native PSE count is preserved.
          send(200, `<entry xmlns="http://www.w3.org/2005/Atom" xmlns:pse="http://vaemendis.net/opds-pse/ns"><id>${root}/items/${index + 1}</id><title>${escapeXml(titles[index])}</title><updated>2026-01-01T00:00:00Z</updated><author><name>${escapeXml(pub.metadata.author[0].name)}</name></author><summary>${escapeXml(pub.metadata.description)}</summary><link rel="http://opds-spec.org/image" href="/fixture-assets/covers/${index + 1}.png" type="image/png"/><link rel="http://vaemendis.net/opds-pse/stream" href="/fixture-assets/pages/{pageNumber}.png" type="image/png" pse:count="3"/><link rel="${ACQUISITION}" href="/fixture-assets/book.cbz" type="application/vnd.comicbook+zip"/></entry>`, 'application/atom+xml;type=entry'); return;
        }
      }
      const catalog = feed(root, path, url.searchParams);
      if (catalog) { send(200, JSON.stringify(catalog), OPDS); return; }
    }
    send(404, 'Missing fixture resource');
  }
  return { handle, requests };
}

export async function startRemoteLibraryUiServer() {
  const fixture = await remoteLibraryUiFixture(), server = createServer(fixture.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Loopback server did not start');
  return { ...fixture, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
