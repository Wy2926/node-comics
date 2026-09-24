// Reproducible pixel-preserving composition of user-supplied screenshots.
// The generated paper background is decorative; all UI comes from original pixels.
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../backend/website/package.json',import.meta.url));
const sharp=require('sharp');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'artifacts/marketing/2026-09-24/screenshots');
const background=process.argv[2];
const inputs=process.argv.slice(3);
if(!background||inputs.length!==6)throw Error('Usage: node scripts/prepare_marketing_screenshots.mjs BACKGROUND.png SHOT1.png SHOT2.png SHOT3.png SHOT4.png SHOT5.png POPUP.png');
for(const dir of ['sources','master-2560x1600','store-1280x800','chrome-store-selected-5','web-1600x1000'])await mkdir(path.join(out,dir),{recursive:true});
await copyFile(background,path.join(out,'sources/brand-paper-background.png'));
const svg=(body,w=2560,h=1600)=>Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
const text=(s,x,y,size=32,weight=400,color='#526981')=>`<text x="${x}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(s)}</text>`;
const base=await sharp(background).resize(2560,1600,{fit:'cover'}).flatten({background:'#f4f8ff'}).png().toBuffer();
const logo=await sharp(path.join(root,'apps/extension/src/assets/brand/logo-horizontal-en-light.webp')).resize({width:400}).png().toBuffer();
const crops=[];
async function framed(source,rect,x,y,width,opts={}) {
  const height=Math.round(rect.height*width/rect.width),radius=opts.radius??24;
  crops.push({source:path.basename(source),crop:rect,placement:{x,y,width,height}});
  const content=await sharp(source).extract(rect).resize(width,height,{kernel:'lanczos3'}).png().toBuffer();
  const rounded=await sharp(content).composite([{input:svg(`<rect width="${width}" height="${height}" rx="${radius}" fill="white"/>`,width,height),blend:'dest-in'}]).png().toBuffer();
  return [
    {input:svg(`<rect x="${x+10}" y="${y+14}" width="${width}" height="${height}" rx="${radius}" fill="#1f324b" opacity=".10"/><rect x="${x-2}" y="${y-2}" width="${width+4}" height="${height+4}" rx="${radius+2}" fill="#c2d3e7"/>`),left:0,top:0},
    {input:rounded,left:x,top:y},
  ];
}
const specs=[
  {slug:'01-your-comic-library',label:'YOUR LIBRARY',title:'Your comics. One place.',subtitle:'Open supported web comics and your own comic files.',layout:async s=>framed(s,{left:350,top:104,width:1328,height:760},246,338,2068)},
  {slug:'02-reading-controls',label:'READING COMFORT',title:'Read your way.',subtitle:'Choose your layout, reading direction, zoom and background.',layout:async s=>[
    ...await framed(s,{left:768,top:402,width:506,height:796},340,336,756),
    ...await framed(s,{left:1580,top:12,width:374,height:691},1500,336,644),
  ]},
  {slug:'03-translation-languages',label:'TRANSLATION OPTIONS',title:'Your language. Your choice.',subtitle:'Choose a target language and a translation mode.',layout:async s=>[
    ...await framed(s,{left:768,top:402,width:506,height:796},340,336,756),
    ...await framed(s,{left:1645,top:442,width:310,height:569},1470,336,650),
  ]},
  {slug:'04-supported-websites',label:'WEB COMICS',title:'From a supported site to your shelf.',subtitle:'Paste a comic link, explore supported sources, or request a new site.',layout:async s=>[
    ...await framed(s,{left:360,top:320,width:1310,height:148},160,350,2240),
    ...await framed(s,{left:356,top:523,width:923,height:397},160,700,1540),
    ...await framed(s,{left:1308,top:521,width:365,height:391},1790,700,610),
  ]},
  {slug:'05-personalize-your-reader',label:'MAKE IT YOURS',title:'A reader that feels like yours.',subtitle:'Choose your interface language, accent color, theme and text size.',layout:async s=>framed(s,{left:454,top:322,width:1124,height:535},160,425,2240)},
  {slug:'06-browser-popup',label:'BROWSER POPUP',title:'Translate from your toolbar.',subtitle:'Choose a language, translate the current tab, or open your comics.',layout:async s=>[
    {input:svg(
      text('01',185,523,28,700,'#1769b3')+text('Choose a language',185,585,52,700,'#1c2d44')+text('Set the target language for the page.',185,646,32)+
      '<path d="M185 712H1120" stroke="#c4d5e8" stroke-width="2"/>'+
      text('02',185,800,28,700,'#1769b3')+text('Translate the current tab',185,862,52,700,'#1c2d44')+text('Start from the extension popup.',185,923,32)+
      '<path d="M185 989H1120" stroke="#c4d5e8" stroke-width="2"/>'+
      text('03',185,1077,28,700,'#1769b3')+text('Continue your story',185,1139,52,700,'#1c2d44')+text('Open your comics from the same menu.',185,1200,32)
    ),left:0,top:0},
    ...await framed(s,{left:0,top:0,width:420,height:600},1430,340,800),
  ]},
];
const manifest={date:'2026-09-24',product:'NodeLane Comics',kind:'Promotional compositions of user-provided real extension screenshots',uiPolicy:'Original UI pixels are cropped and uniformly resampled, never generated, relabeled, reconstructed or sharpened with AI. Detail crops are arranged separately on slides 2, 3 and 4.',background:'Built-in ImageGen: standalone neutral paper texture; no reference screenshot reproduced.',upscaleNote:'2560x1600 is the layout canvas size, not a claim that source UI contains new image detail.',outputs:[]};
const thumbnails=[];
for(let index=0;index<specs.length;index++) {
  const spec=specs[index],source=inputs[index],sourceBytes=await readFile(source);
  await copyFile(source,path.join(out,'sources',spec.slug+'.png'));
  crops.length=0;
  const shotLayers=await spec.layout(source);
  const header=svg(text(spec.label,2050,91,23,600,'#1769b3')+text(spec.title,152,200,76,700,'#1c2d44')+text(spec.subtitle,154,271,34,400,'#526981')+text('comics.nodelane.net',154,1570,23,400,'#657b91'));
  const master=await sharp(base).composite([{input:logo,left:145,top:44},{input:header,left:0,top:0},...shotLayers]).flatten({background:'#f4f8ff'}).removeAlpha().png().toBuffer();
  const masterPath=path.join(out,'master-2560x1600',spec.slug+'.png');
  const storePath=path.join(out,'store-1280x800',spec.slug+'.png');
  const webPath=path.join(out,'web-1600x1000',spec.slug+'.webp');
  await writeFile(masterPath,master);
  await sharp(master).resize(1280,800).removeAlpha().png().toFile(storePath);
  await sharp(master).resize(1600,1000).webp({quality:92}).toFile(webPath);
  const metadata=await sharp(storePath).metadata();
  if(metadata.width!==1280||metadata.height!==800||metadata.hasAlpha)throw Error('Store image does not meet dimensions/alpha requirements.');
  thumbnails.push({input:await sharp(master).resize(640,400).jpeg({quality:93}).toBuffer(),left:(index%2)*640,top:Math.floor(index/2)*400});
  const sourceMetadata=await sharp(sourceBytes).metadata();
  manifest.outputs.push({name:spec.slug,title:spec.title,sourceResolution:{width:sourceMetadata.width,height:sourceMetadata.height},sourceSha256:createHash('sha256').update(sourceBytes).digest('hex'),crops:[...crops],master:path.relative(out,masterPath),store:path.relative(out,storePath),web:path.relative(out,webPath)});
}
for(const [rank,index] of [5,0,2,1,3].entries())await copyFile(path.join(out,'store-1280x800',specs[index].slug+'.png'),path.join(out,'chrome-store-selected-5',String(rank+1).padStart(2,'0')+'-'+specs[index].slug.slice(3)+'.png'));
await sharp({create:{width:1280,height:1200,channels:3,background:'#edf4fc'}}).composite(thumbnails).jpeg({quality:94}).toFile(path.join(out,'contact-sheet.jpg'));
await writeFile(path.join(out,'asset-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(out,'README.md'),`# NodeLane Comics screenshot kit\n\nPrepared 2026-09-24 from six real extension screenshots supplied by the user.\n\n- chrome-store-selected-5: recommended upload set and order: popup, library, translation options, reading controls, supported websites. Chrome allows at most five screenshots.\n- store-1280x800: all six RGB PNG images, 1280 x 800, no alpha.\n- master-2560x1600: six large PNG presentation canvases. Sources: five 2042 x 1214 captures and one 420 x 600 popup. Upscaling does not create new UI detail.\n- web-1600x1000: six compressed WebP images for website use.\n- contact-sheet.jpg: overview.\n- sources: untouched captures and the standalone ImageGen paper background. Keep this folder local.\n- asset-manifest.json: crop regions, placements and source hashes.\n\nThe UI, manga pages, site labels, counts and displayed options are retained from the supplied pixels. Separate detail crops are composed on slides 2, 3 and 4. The slides do not show a newly generated translation, claim support for every site, or claim store approval. The comic content is user-supplied third-party material, not project-original art. No public upload or publication is performed by this script.\n\nDecorative background: built-in ImageGen; prompt: standalone off-white / pale ice-blue paper, restrained blue halftone edges, no people, screenshots, text, logos or panels. All typography and image placement are deterministic.\n\nImage specifications checked against https://developer.chrome.com/docs/webstore/images on 2026-09-24.\n\nRebuild: node scripts/prepare_marketing_screenshots.mjs BACKGROUND.png SHOT1.png SHOT2.png SHOT3.png SHOT4.png SHOT5.png POPUP.png\n`);
console.log(JSON.stringify({outputDirectory:out,count:specs.length,formats:['2560x1600 PNG','1280x800 PNG','1600x1000 WebP']},null,2));
