import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../../..');
const require = createRequire(path.join(root, 'backend/website/package.json'));
const sharp = require('sharp');
const ink = '#202D43', blue = '#1769B3', pink = '#E879A4';
const source = path.join(dir, 'generated-master.png');
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let left = info.width, top = info.height, right = 0, bottom = 0;
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    // Remove only near-invisible alpha noise returned by the provider.
    if (data[i + 3] <= 8) {
      data.fill(0, i, i + 4);
      continue;
    }
    if (data[i + 3] >= 248) data[i + 3] = 255;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
}
const clipped = await sharp(data, { raw: info })
  .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
  .resize(896, 896, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
const cm = await sharp(clipped).metadata();
const master = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
  .composite([{ input: clipped, left: Math.round((1024 - cm.width) / 2), top: Math.round((1024 - cm.height) / 2) }])
  .png().toBuffer();
await fs.writeFile(path.join(dir, 'logo-mark-1024.png'), master);
const outputs = ['logo-mark-1024.png'];
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  const name = `icon-${size}.png`;
  await sharp(master).resize(size, size).png().toFile(path.join(dir, name));
  outputs.push(name);
}
await sharp(master).webp({ lossless: true }).toFile(path.join(dir, 'logo-mark-1024.webp'));
outputs.push('logo-mark-1024.webp');
const encoded = master.toString('base64');
const mark = (x, y, size) => `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/png;base64,${encoded}"/>`;
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g font-family="Segoe UI,Microsoft YaHei,sans-serif">${body}</g></svg>`);
for (const lang of ['zh', 'en']) {
  for (const theme of ['light', 'dark']) {
    const color = theme === 'light' ? ink : '#F7F9FC';
    const accent = theme === 'light' ? blue : '#8DC7FF';
    const text = lang === 'zh' ? '漫译' : 'Comics';
    const name = `logo-horizontal-${lang}-${theme}.png`;
    const lockup = svg(1600, 320, `${mark(16,16,288)}<text x="354" y="213" font-size="145" font-weight="700" letter-spacing="-4" fill="${color}">NodeLane</text><text x="1055" y="211" font-size="${lang === 'zh' ? 139 : 130}" font-weight="${lang === 'zh' ? 700 : 400}" fill="${accent}">${text}</text>`);
    await sharp(lockup).png().toFile(path.join(dir, name));
    await sharp(lockup).webp({ lossless: true }).toFile(path.join(dir, name.replace('.png', '.webp')));
    outputs.push(name, name.replace('.png', '.webp'));
  }
}

// A static presentation sheet; the symbol remains the API-generated bitmap.
const embed = async (name, x, y, w, h) => `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${(await fs.readFile(path.join(dir,name))).toString('base64')}"/>`;
let board = `<rect width="1600" height="1080" fill="#F3F5F8"/>
<text x="80" y="64" font-size="17" letter-spacing="4" font-weight="700" fill="${blue}">NODELANE / VISUAL IDENTITY</text>
<text x="77" y="151" font-size="61" font-weight="700" letter-spacing="-2" fill="${ink}">NodeLane 漫译</text>
<text x="1518" y="143" text-anchor="end" font-size="23" fill="#5E6D82">边看边译，读懂每一格。</text>
<rect x="80" y="211" width="620" height="617" rx="22" fill="#FFF"/>
<text x="112" y="258" font-size="16" font-weight="600" letter-spacing="2" fill="#5E6D82">01 / 核心图形</text>
${mark(130,272,520)}
<rect x="730" y="211" width="790" height="283" rx="22" fill="#151B27"/>
<text x="764" y="255" font-size="16" font-weight="600" letter-spacing="2" fill="#B0BDD1">02 / 官网 · 深色背景</text>
${await embed('logo-horizontal-en-dark.png',760,290,730,146)}
<rect x="730" y="518" width="790" height="310" rx="22" fill="#FFF"/>
<text x="764" y="563" font-size="16" font-weight="600" letter-spacing="2" fill="#5E6D82">03 / 官网 · 浅色背景</text>
${await embed('logo-horizontal-zh-light.png',760,579,730,146)}
<text x="886" y="767" font-size="22" fill="#5E6D82">漫画对白框 × N 字母 × 翻页折角</text>
<rect x="80" y="854" width="920" height="148" rx="18" fill="#FFF"/>
<text x="112" y="895" font-size="16" font-weight="600" letter-spacing="2" fill="#5E6D82">04 / 插件图标 · 实际像素</text>
<rect x="1030" y="854" width="490" height="148" rx="18" fill="#FFF"/>
<text x="1062" y="895" font-size="16" font-weight="600" letter-spacing="2" fill="#5E6D82">05 / 品牌配色参考</text>`;
let sx = 120;
for (const size of [16,24,32,48,64]) {
  board += await embed(`icon-${size}.png`, sx, 934 - size/2, size, size);
  board += `<text x="${sx+size+12}" y="941" font-size="17" fill="#5E6D82">${size} px</text>`;
  sx += 165;
}
for (const [i,color] of [blue,ink,pink].entries()) {
  const x = 1063 + i*150;
  board += `<rect x="${x}" y="918" width="122" height="26" rx="7" fill="${color}"/><text x="${x}" y="974" font-size="16" font-weight="600" fill="#5E6D82">${color}</text>`;
}
board += `<text x="80" y="1047" font-size="16" fill="#5E6D82">NODELANE COMICS · LOGO DESIGN / V1</text><text x="1519" y="1047" text-anchor="end" font-size="16" fill="#5E6D82">官网与浏览器插件</text>`;
await sharp(svg(1600,1080,board)).png().toFile(path.join(dir,'brand-preview.png'));
outputs.push('brand-preview.png');

// ICO stores standard PNG entries, preserving the transparent edges.
const icoSizes = [16,32,48,128,256];
const icoImages = await Promise.all(icoSizes.map(n => fs.readFile(path.join(dir,`icon-${n}.png`))));
const header = Buffer.alloc(6 + icoSizes.length*16);
header.writeUInt16LE(1,2); header.writeUInt16LE(icoSizes.length,4);
let offset = header.length;
icoSizes.forEach((size,i) => {
  const pos = 6+i*16;
  header[pos] = size===256 ? 0 : size; header[pos+1]=header[pos];
  header.writeUInt16LE(1,pos+4); header.writeUInt16LE(32,pos+6);
  header.writeUInt32LE(icoImages[i].length,pos+8); header.writeUInt32LE(offset,pos+12);
  offset += icoImages[i].length;
});
await fs.writeFile(path.join(dir,'favicon.ico'),Buffer.concat([header,...icoImages]));
outputs.push('favicon.ico');
const artifacts = [];
for (const name of outputs) {
  const bytes = await fs.readFile(path.join(dir,name));
  const item = { file:name, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') };
  if (!name.endsWith('.ico')) {
    const meta = await sharp(bytes).metadata();
    Object.assign(item,{ width:meta.width,height:meta.height,alpha:meta.hasAlpha });
    if (name.startsWith('icon-')) {
      const expected = Number(name.match(/icon-(\d+)/)[1]);
      if (meta.width !== expected || meta.height !== expected || !meta.hasAlpha) throw new Error(`Invalid icon: ${name}`);
    }
  }
  artifacts.push(item);
}
await fs.writeFile(path.join(dir,'asset-manifest.json'),JSON.stringify({
  model:'gpt-image-2', endpoint:'https://sub2api.nodelane.net/v1/images/generations',
  requestedSize:'1536x1536',receivedSize:`${info.width}x${info.height}`,quality:'high',
  generationMode:'imagegen skill bundled CLI',
  sourceAlpha:'Provider returned RGBA; no chroma-key removal was needed.',
  postProcessing:'Remove alpha <= 8 noise, make alpha >= 248 opaque, crop, pad, resize, typeset website lockups.',
  fonts:'Locally installed Windows Segoe UI Bold / Segoe UI and Microsoft YaHei; rasterized text only, no font files distributed.',
  sharpVersion:sharp.versions.sharp, artifacts
},null,2)+'\n');
console.log(JSON.stringify({exported:outputs.length,source:[info.width,info.height],visibleBounds:[left,top,right,bottom],icons:'16,24,32,48,64,128,256,512',folder:dir},null,2));
