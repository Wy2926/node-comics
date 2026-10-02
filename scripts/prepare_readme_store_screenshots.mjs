// Crop real README pixels onto a separately generated background. No image API calls.
import {createRequire} from 'node:module';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../backend/website/package.json', import.meta.url));
const sharp = require('sharp');
const out = path.resolve(root, process.argv[3] || 'output/chrome-web-store-current/screenshots');
const background = path.resolve(root, process.argv[2] || 'output/imagegen/blue-manga-store/background.png');
const svg = body => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800">${body}</svg>`);
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (s, x, y, size, color = '#1c2d44', weight = 400) => `<text x="${x}" y="${y}" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escape(s)}</text>`;
const rect = (left, top, width, height) => ({left, top, width, height});
const specs = [
  {name: 'translation-comparison', zh: ['用熟悉的语言，读懂漫画。', '对照原文与译文，随时切回原图继续阅读。'], en: ['Read manga in your language.', 'Compare the original with a Chinese translation, side by side.'], crops: [[rect(0,90,1718,960),128,174,1024]]},
  {name: 'cross-language-search', zh: ['跨越语言，找到想看的。', '按名称与别名搜索，选择网站，确认后导入阅读。'], en: ['Find stories across languages.', 'Search by title or alias, choose websites, and import a result.'], crops: [[rect(170,206,775,401),64,188,550],[rect(960,206,576,484),654,188,562],[rect(170,1020,675,212),64,526,550]]},
  {name: 'reader-directory', zh: ['章节与语言，一目了然。', '在阅读器中浏览目录，查看缓存与阅读状态。'], en: ['Chapters at a glance.', 'Browse the chapter list, languages, cache status and reading progress.'], crops: [[rect(0,0,1718,1307),272,174,736]]},
  {name: 'library', zh: ['你的漫画，随时接着看。', '整理书架、导入漫画，继续上次的阅读进度。'], en: ['Your comics. Ready to read.', 'Organize your library and pick up where you left off.'], crops: [[rect(170,108,1386,716),100,174,1080]]},
  {name: 'offline-center', zh: ['提前缓存，离线也能看。', '查看缓存进度与空间占用，随时暂停或继续。'], en: ['Cache now. Read offline.', 'Track cache progress and storage use. Pause and resume anytime.'], crops: [[rect(170,108,1386,409),64,270,1152]]},
];
await mkdir(out, {recursive:true});
const base = await sharp(background).resize(1280,800,{fit:'cover'}).flatten({background:'#f4f8ff'}).png().toBuffer();
const manifest = {background: path.relative(root,background).replaceAll('\\','/'), backgroundSha256:createHash('sha256').update(await readFile(background)).digest('hex'), size:[1280,800], policy:'Real README screenshot pixels only; deterministic crop and uniform resizing. Background generated separately.', outputs:[]};
const thumbs = [];
for (const [language, readme] of [['zh-CN','README.md'],['en','README_EN.md']]) {
  const readmeText = await readFile(path.join(root,readme),'utf8');
  const dir = path.join(out,language);
  await mkdir(dir,{recursive:true});
  const logo = await sharp(path.join(root,`apps/extension/src/assets/brand/logo-horizontal-${language === 'en' ? 'en' : 'zh'}-light.webp`)).resize({width:210}).png().toBuffer();
  for (const [index,spec] of specs.entries()) {
    const source = `docs/images/${language === 'en' ? 'en/' : ''}${spec.name}.png`;
    if (!readmeText.includes(`](${source})`)) throw Error(`Screenshot not referenced by ${readme}: ${source}`);
    const input = await readFile(path.join(root,source));
    const meta = await sharp(input).metadata();
    if (meta.width !== 1718 || meta.height !== 1307) throw Error(`Recheck crop coordinates for ${source}`);
    const [title,subtitle] = language === 'en' ? spec.en : spec.zh;
    const layers = [{input:logo,left:64,top:26},{input:svg('<rect x="54" y="759" width="155" height="29" rx="8" fill="#f4f8ff" fill-opacity=".94"/><rect x="1136" y="28" width="80" height="31" rx="8" fill="#f4f8ff" fill-opacity=".94"/>'+text(title,64,108,language === 'en' ? 36 : 38,'#1c2d44',700)+text(subtitle,66,145,18,'#526981')+text('comics.nodelane.net',64,779,13,'#526981')+text(`${String(index+1).padStart(2,'0')} / ${String(specs.length).padStart(2,'0')}`,1150,49,14,'#1769b3',700)),left:0,top:0}];
    const placements = [];
    // English search capture has a back button and a taller header than Chinese.
    const crops = language === 'en' && spec.name === 'cross-language-search'
      ? [[rect(170,306,775,401),64,188,550],[rect(960,306,576,484),654,188,562],[rect(170,820,1370,282),64,526,550]]
      : spec.crops;
    for (const [crop,x,y,width] of crops) {
      const height = Math.round(crop.height*width/crop.width);
      if (x+width > 1280 || y+height > 752) throw Error('Screenshot exceeds content area');
      const content = await sharp(input).extract(crop).resize(width,height).png().toBuffer();
      layers.push({input:svg(`<rect x="${x+6}" y="${y+7}" width="${width}" height="${height}" rx="8" fill="#1c2d44" opacity=".18"/><rect x="${x-2}" y="${y-2}" width="${width+4}" height="${height+4}" rx="8" fill="#829fbd"/>`),left:0,top:0});
      layers.push({input:content,left:x,top:y});
      placements.push({crop,x,y,width,height});
    }
    const filename = `${String(index+1).padStart(2,'0')}-${spec.name}-1280x800.png`;
    const result = await sharp(base).composite(layers).flatten({background:'#f4f8ff'}).removeAlpha().png().toBuffer();
    await writeFile(path.join(dir,filename),result);
    const verified = await sharp(result).metadata();
    if (verified.width !== 1280 || verified.height !== 800 || verified.hasAlpha || verified.channels !== 3) throw Error('Invalid output format');
    manifest.outputs.push({language,file:`${language}/${filename}`,source,sourceSha256:createHash('sha256').update(input).digest('hex'),placements});
    thumbs.push({input:await sharp(result).resize(640,400).png().toBuffer(),left:language === 'en' ? 640 : 0,top:index*400});
  }
}
await sharp({create:{width:1280,height:specs.length*400,channels:3,background:'#f4f8ff'}}).composite(thumbs).jpeg({quality:92}).toFile(path.join(out,'contact-sheet.jpg'));
await writeFile(path.join(out,'asset-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(out,'README.md'),`# Chrome Web Store 截图\n\n复用现有蓝色漫画风背景，产品界面和漫画内容均裁剪自根目录中英文 README 的真实截图；未生成或修改界面与对白。\n\n- zh-CN/、en/：各 5 张 1280×800 RGB PNG，无透明通道。\n- 上传顺序：翻译对照、跨语言搜索、阅读目录、书架、离线中心。\n- contact-sheet.jpg：左中文、右英文的总览。\n- asset-manifest.json：来源摘要、裁剪坐标和摆放尺寸。\n\n首图保留阅读器两侧工具栏。英文原截图展示的是英文原图与中文译文，副标题据此明确写为 Chinese translation。离线中心保持原截图的实际进度。\n\n重建：\n\n\`\`\`powershell\nnode scripts/prepare_readme_store_screenshots.mjs\n\`\`\`\n\n背景：output/imagegen/blue-manga-store/background.png。默认输出：output/chrome-web-store-current/screenshots。\n`);
console.log(JSON.stringify({output:out,images:manifest.outputs.length,dimensions:'1280x800',channels:'RGB, no alpha'},null,2));
