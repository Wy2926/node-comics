/** Render the actual bundled font specimens, offline; no image or text model. */
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=path.resolve(process.argv[2]||'artifacts/translation-fonts/preview');
const catalog=JSON.parse(await readFile('backend/shared/translation-fonts.json','utf8'));
const sources=JSON.parse(await readFile('apps/extension/public/fonts/translation/sources.json','utf8'));
const labels={'zh-Hans':'简体中文','zh-Hant':'繁體中文',ja:'日本語',ko:'한국어',en:'English',fr:'Français',es:'Español','pt-BR':'Português (Brasil)',de:'Deutsch',it:'Italiano',ru:'Русский',pl:'Polski',uk:'Українська',tr:'Türkçe',vi:'Tiếng Việt',id:'Bahasa Indonesia',ar:'العربية'};
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const faces=await Promise.all(catalog.fonts.map(async font=>{
  const bytes=await readFile(`apps/extension/public/fonts/translation/${font.id}.woff2`);
  return `@font-face{font-family:'preview-${font.id}';src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');font-weight:400;font-style:normal;font-display:block}`;
}));
const sections=Object.entries(catalog.samples).map(([language,sample])=>{
  const fonts=catalog.fonts.filter(font=>font.languages.includes(language));
  return `<section id="${language}" data-language="${language}">
    <div class="section-title"><h2>${escape(labels[language])}</h2><span>${fonts.length} 个可选字体 · 30 px / 18 px</span></div>
    <div class="grid">${fonts.map((font,index)=>`<article>
      <div class="font-name"><span>${String(index+1).padStart(2,'0')}</span><h3 lang="${language}" dir="${language==='ar'?'rtl':'ltr'}">${escape(font.names[language])}</h3></div>
      <div class="bubble" lang="${language}" dir="${language==='ar'?'rtl':'ltr'}" style="font-family:'preview-${font.id}'"><span>${escape(sample)}</span></div>
      <p class="small-sample" lang="${language}" dir="${language==='ar'?'rtl':'ltr'}" style="font-family:'preview-${font.id}'">${escape(sample)}</p>
      <footer>实际字体 · ${escape(sources.fonts.find(source=>source.id===font.id).source_version.split(';')[0])}</footer>
    </article>`).join('')}</div>
  </section>`;
}).join('');
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeLane · 漫画翻译字体实际对照</title><style>
${faces.join('\n')}
.bubble>span{display:block;width:100%;min-width:0}
*{box-sizing:border-box}body{margin:0;background:#edf1f4;color:#182833;font-family:"Segoe UI","Microsoft YaHei",sans-serif;padding:40px}main{max-width:1320px;margin:auto}.eyebrow{font-size:12px;font-weight:650;letter-spacing:.16em;color:#35758d}h1{font-size:30px;letter-spacing:-.02em;margin:10px 0 12px}header p{font-size:14px;line-height:1.75;color:#516574;margin:0;max-width:960px}nav{display:flex;flex-wrap:wrap;gap:6px;margin:22px 0 30px}nav button{font:inherit;font-size:12px;border:1px solid #cbd6dd;border-radius:7px;padding:7px 10px;background:#fff;color:#3e5362;cursor:pointer}nav button[aria-pressed=true]{background:#234958;border-color:#234958;color:white}.section-title{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px}.section-title h2{font-size:21px;margin:0}.section-title span{font-size:12px;color:#516574}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}article{padding:21px;background:#fff;border:1px solid #d6dfe4;border-radius:12px;min-width:0}.font-name{display:flex;align-items:center;gap:9px;margin-bottom:18px}.font-name>span{font-size:11px;color:#66818d;border:1px solid #dde6eb;border-radius:5px;padding:3px 5px}.font-name h3{font-size:14px;margin:0;font-weight:600}.bubble{font-weight:400;font-synthesis:none;font-size:30px;line-height:1.5;text-align:center;border:1.5px solid #182833;border-radius:45%;background:#fff;padding:24px 25px;min-height:174px;display:flex;align-items:center;justify-content:center;color:#15191c;overflow-wrap:anywhere}.small-sample{font-size:18px;line-height:1.65;font-weight:400;font-synthesis:none;min-height:60px;margin:22px 1px 12px;color:#242d32}footer{font-size:10px;color:#82929c;line-height:1.5;border-top:1px solid #e8edf0;padding-top:10px}section{display:none}section[data-active]{display:block}.overview section{display:block;margin:32px 0}.footnote{font-size:12px;line-height:1.8;color:#627886;margin:22px 0 0}.print-note{font-size:11px;margin-top:6px}a{color:#35758d}@media(max-width:800px){body{padding:20px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bubble{font-size:26px}}@media(max-width:500px){.grid{grid-template-columns:1fr}.section-title{display:block}.section-title span{display:block;margin-top:7px}}@media print{nav{display:none}section{display:block;break-before:page}header{break-after:avoid}article{break-inside:avoid}body{padding:0}}
</style></head><body><main><header><div class="eyebrow">NODELANE / LETTERING SPECIMENS</div><h1>漫画翻译字体 · 实际效果对照</h1><p>17 种目标语言，每种 5–7 个选择。每组使用同一句对白、同一字号和相同气泡，直接加载插件内置的真实字形，不用系统字体代替，也不做人工加粗。</p></header><nav aria-label="目标语言">${Object.keys(catalog.samples).map(language=>`<button data-lang="${language}" aria-pressed="false">${escape(labels[language])}</button>`).join('')}<button data-lang="all" aria-pressed="false">全部展开</button></nav>${sections}<p class="footnote">浏览器实字体预览；实际译图由计算节点按气泡空间调整字号、换行、方向和描边，因此预览不等同于特定漫画页的最终排版。CJK 通用 Noto 文件使用 SC 字形版本，保留完整 Noto 缺字回退。</p><p class="footnote print-note">所有来源、固定版本、SHA-256 与 OFL 许可随字体资源保存。此页面完全离线，可保存后反复查看。</p></main><script>
function show(language){document.body.classList.toggle('overview',language==='all');for(const section of document.querySelectorAll('section'))section.toggleAttribute('data-active',section.dataset.language===language);for(const button of document.querySelectorAll('nav button'))button.setAttribute('aria-pressed',String(button.dataset.lang===language));window.selectedLanguage=language;}
for(const button of document.querySelectorAll('nav button'))button.addEventListener('click',()=>show(button.dataset.lang));show('zh-Hans');
</script></body></html>`;
await mkdir(output,{recursive:true});
await writeFile(path.join(output,'index.html'),html);
const browser=await chromium.launch({headless:true,executablePath:process.env.TEST_CHROMIUM});
const page=await browser.newPage({viewport:{width:1380,height:1050},deviceScaleFactor:1});
try{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http{,s}://**/*',route=>route.abort());
  await page.goto(pathToFileURL(path.join(output,'index.html')).href);
  for(const language of Object.keys(catalog.samples)){
    await page.locator(`button[data-lang="${language}"]`).click();
    await page.evaluate(async()=>{
      await Promise.all([...document.querySelectorAll('section[data-active] .bubble')].map(element=>
        document.fonts.load(`30px ${getComputedStyle(element).fontFamily}`,element.textContent)));
      await new Promise(requestAnimationFrame);
    });
    const facesReady=await page.evaluate(()=>[...document.querySelectorAll('section[data-active] .bubble')].every(element=>document.fonts.check(`30px ${getComputedStyle(element).fontFamily}`,element.textContent)));
    if(!facesReady)throw Error('Specimen font did not load: '+language);
    const fits=await page.evaluate(()=>[...document.querySelectorAll('section[data-active] .bubble>span')].every(element=>{
      const range=document.createRange();range.selectNodeContents(element);
      const text=range.getBoundingClientRect(),bubble=element.parentElement.getBoundingClientRect();
      return text.left>=bubble.left&&text.right<=bubble.right&&text.top>=bubble.top&&text.bottom<=bubble.bottom;
    }));
    if(!fits)throw Error('Specimen text overflow: '+language);
    await page.screenshot({path:path.join(output,`${language}.png`),fullPage:true});
  }
  if(errors.length)throw Error(errors.join('\n'));
  await writeFile(path.join(output,'verification.json'),JSON.stringify({renderer:'Chromium '+browser.version(),fonts:catalog.fonts.length,languages:17,choices:Object.fromEntries(Object.keys(catalog.samples).map(language=>[language,catalog.fonts.filter(font=>font.languages.includes(language)).length])),samples:'actual bundled WOFF2, no network, 30px / 18px'},null,2)+'\n');
  console.log(JSON.stringify({output,fonts:catalog.fonts.length,languages:17}));
}finally{await browser.close();}
