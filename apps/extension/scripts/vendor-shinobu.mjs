import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// Rebuild only from the reviewed upstream revision. No network, installs or model downloads.
const revision='c4239a2c653c68f66283b990f96936234c8d7294';
const source=path.resolve(process.argv[2]??'../ShinobuTranslator');
const destination=fileURLToPath(new URL('../third_party/shinobu/',import.meta.url));
const provenance=path.join(destination,'provenance.json');
const previous=fs.existsSync(provenance)?JSON.parse(fs.readFileSync(provenance,'utf8')).vendoredSha256:{};
if(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim()!==revision)throw Error('Unexpected upstream revision');
if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:source,encoding:'utf8'}).trim())throw Error('Upstream tracked sources must be clean');
const blob=file=>execFileSync('git',['cat-file','blob',`${revision}:${file}`],{cwd:source});
const aliases=new Map([
  ['@shinobu/model-runtime','packages/model-runtime/src/index.ts'],
  ['@shinobu/browser-runtime/trusted-types','packages/browser-runtime/src/trustedTypesPolicy.ts'],
  ['@shinobu/diagnostics','packages/diagnostics/src/diagnosticLog.ts'],
  ['@shinobu/image-pipeline/benchmark','packages/image-pipeline/src/runtime/platform.ts'],
]);
const seen=new Set(),hashes={};
const resolve=filename=>['', '.ts','/index.ts'].map(suffix=>filename+suffix).find(value=>fs.existsSync(path.join(source,value))&&fs.statSync(path.join(source,value)).isFile());
const adapter=fileURLToPath(new URL('../src/translation/channels/adapters/shinobu/',import.meta.url));
const pending=fs.readdirSync(adapter,{recursive:true}).filter(file=>/(?<!\.test)\.tsx?$/.test(file)).flatMap(file=>
  ts.preProcessFile(fs.readFileSync(path.join(adapter,file),'utf8')).importedFiles.flatMap(({fileName})=>{
    const spec=fileName.split('/third_party/shinobu/')[1];return spec&&!spec.endsWith('.json')?[spec+'.ts']:[];
  }));
if(!pending.length)throw Error('No Shinobu source imports found');
const statements=(file,content,keep)=>ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true).statements
  .filter(node=>keep(node.name?.text,node)).map(node=>node.getFullText()).join('').trimStart()+'\n';
const probes=new Set(['CheckStatus','RuntimeCheckItem','NavigatorWithMl','verifyWasmSession','verifyWebnnSession','probeRuntime','probePaddleGraphCapture','PaddleGraphCaptureProbeOptions','PaddleGraphCaptureProbeResult']);
while(pending.length){
  const file=pending.pop();if(seen.has(file))continue;seen.add(file);
  const original=blob(file).toString('utf8');
  hashes[file]=crypto.createHash('sha256').update(original).digest('hex');
  let content=original;
  // The stage algorithms share geometry types, not the upstream application, editor or text service.
  if(file==='packages/image-pipeline/src/index.ts')content=statements(file,content,name=>['QuadPoint','Rect','TextDirection'].includes(name));
  if(file==='packages/image-pipeline/src/types.ts')content=`import type { PipelineCanvas } from './runtime/platform';
import type { RegionMaskOwnership } from './editor/types';
import type { QuadPoint, Rect, TextDirection } from './index';
export type { QuadPoint, Rect, TextDirection };

`+statements(file,content,name=>/^(SourceTextLineGeometry|BubbleMask|TextRegion|RuntimeStageStatus|Typeset|PipelineTypeset|Ocr|Paddle|MaskDebugLayers|RefineTextMaskResult)/.test(name));
  if(file.endsWith('/diagnosticLog.ts'))content=statements(file,content,name=>/^DiagnosticLog(Level|Category|Context|Source|Error|Event|EventInput|Observer)$/.test(name));
  if(file.endsWith('/offscreenPlatform.ts'))content=statements(file,content,name=>name!=='createNormalizedWorkingFile').replace('class BitmapPipelineImage','export class BitmapPipelineImage');
  if(file.endsWith('/pipeline/image.ts'))content=statements(file,content,(name,node)=>ts.isImportDeclaration(node)||name==='tryNativeOpaqueMaskThreshold').replace('PipelineImage, ','');
  // Do not expose upstream benchmark/self-check RPCs in the production ONNX Worker.
  if(file.startsWith('packages/model-runtime/')&&/\b(?:probeRuntime|PaddleGraphCaptureProbeOptions)\b/.test(content)){
    content=statements(file,content,name=>!probes.has(name))
      .replace(/^(?:import|export) type \{ RuntimeSelfCheckReport \} from [^\n]+\n/gm,'')
      .replace(/^  (?:PaddleGraphCaptureProbeOptions|PaddleGraphCaptureProbeResult|probeRuntime|probePaddleGraphCapture),\r?\n/gm,'')
      .replace(/  probeRuntime\(modelUrl:[^;]+;\s+probePaddleGraphCapture\([^;]+;\r?\n/,'');
  }
  content=content.replace(/(['"])(@shinobu\/[^'"]+|\.{1,2}\/[^'"]+)\1/g,(match,quote,spec)=>{
    const target=aliases.get(spec)??resolve(path.posix.join(path.posix.dirname(file),spec));
    if(!target)return match;
    pending.push(target);
    let relative=path.posix.relative(path.posix.dirname(file),target).replace(/\.ts$/,'');
    if(!relative.startsWith('.'))relative='./'+relative;
    return quote+relative+quote;
  });
  // Upstream diagnostics may include OCR text and raw responses. Remove console calls at build source,
  // retaining the code around them; the adapter exposes only finite error identifiers.
  const ast=ts.createSourceFile(file,content,ts.ScriptTarget.Latest,true);
  const edits=[];
  function visit(node){
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(ast)==='console'){
      edits.push([node.getStart(ast),node.end,'void 0']);return;
    }
    if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations)if(ts.isIdentifier(declaration.name)&&['reason','message'].includes(declaration.name.text))edits.push([node.end,node.end,' void '+declaration.name.text+';']);
    ts.forEachChild(node,visit);
  }visit(ast);
  for(const [start,end,value] of edits.sort((a,b)=>b[0]-a[0]))content=content.slice(0,start)+value+content.slice(end);
  if(file.endsWith('/ocr/paddleocrPreprocess.ts'))content=content.replace('direction, inputHeight, platform);','direction, inputHeight, platform, maxInputWidth);')
    .replace("resizeCanvas.getContext('2d')","resizeCanvas.getContext('2d', { willReadFrequently: true })")
    .replace('const pixels = imageData.data;', 'source.dispose?.();\n  resizeCanvas.dispose?.();\n  const pixels = imageData.data;');
  if(file.endsWith('/ocr/preprocess.ts'))content=content.replace(/(export function getTransformedRegion\([\s\S]+?platform: PlatformProvider,)/,'$1\n  maxWidth = Infinity,')
    .replace('warpPerspectiveRegion(source, localQuad, outW, outH, platform)','warpPerspectiveRegion(source, localQuad, Math.min(outW, maxWidth), Math.min(outH, maxWidth), platform)')
    .replace('const sctx = source.getContext("2d")','const sctx = source.getContext("2d", { willReadFrequently: true })')
    .replace('if (direction === "v") {\n    return rotate90CounterClockwise(warped, platform);','source.dispose?.();\n  if (direction === "v") {\n    const rotated = rotate90CounterClockwise(warped, platform);\n    if (rotated !== warped) warped.dispose?.();\n    return rotated;');
  if(file.endsWith('/ocr/paddleocrProvider.ts'))content=content.replace('debugInfo.chunkBatchSize = Math.max(1, ...Array.from(groups.values(), (group) => group.length));',
    'const maxBatch = 4; // Bound logits and activation memory even when all lines share one width.\n        debugInfo.chunkBatchSize = Math.min(maxBatch, Math.max(1, ...Array.from(groups.values(), (group) => group.length)));')
    .replace('await runPreparedGroup(group, bucketWidth, true);','for (let i = 0; i < group.length; i += maxBatch) await runPreparedGroup(group.slice(i, i + maxBatch), bucketWidth, true);');
  if(file.endsWith('typeset/drawTypeset.ts'))content=content
    .replace('import { formatTypesetFont, resolveTypesetFontFamily }', 'import { formatTypesetFont, resolveTypesetFontFamily, supportedTypesetText }')
    .replace('const translatedRaw = inputRegion.translatedText;', 'const translatedRaw = supportedTypesetText(inputRegion.translatedText);\n    inputRegion.translatedText = translatedRaw;\n    if (!translatedRaw.trim()) continue;');
  if(file.endsWith('typeset/fontRuntime.ts'))content=`// The isolated worker shares one verified font for measurement and rendering.
let weight=400;
let selectedFamily='';
let coverage:number[][]=[];
export function configureTypesetFont(family:string,fontWeight:number,ranges:number[][]){selectedFamily=family;weight=fontWeight;coverage=ranges;}
export function supportedTypesetText(text:string):string {
  let supported='';
  for(const character of text){
    if(/\\s/u.test(character)){supported+=character;continue;}
    const point=character.codePointAt(0)!;
    let low=0,high=coverage.length-1;
    while(low<=high){
      const mid=(low+high)>>>1,[start,end]=coverage[mid];
      if(point<start)high=mid-1;else if(point>end)low=mid+1;else{supported+=character;break;}
    }
  }
  return supported;
}
export function resolveTypesetFontFamily(_targetLang?:string):string {
  if(!selectedFamily)throw Error('Font not configured');
  return JSON.stringify(selectedFamily);
}
export function formatTypesetFont(size:number,family:string){return weight+' '+size+'px '+family;}
`;
  const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
}
for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md','packages/model-manifest/manifest.json','packages/model-manifest/publication-policy.json','public/models/models.json']){
  const target=path.join(destination,file),bytes=blob(file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  hashes[file]=crypto.createHash('sha256').update(bytes).digest('hex');
}
const files=Object.keys(hashes).sort(),upstreamSha256=Object.fromEntries(files.map(file=>[file,hashes[file]]));
const vendoredSha256=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(destination,file))).digest('hex')]));
for(const file of Object.keys(previous))if(file.endsWith('.ts')&&!seen.has(file))fs.rmSync(path.join(destination,file),{force:true});
fs.writeFileSync(path.join(destination,'provenance.json'),JSON.stringify({source:'https://github.com/DonutShinobu/ShinobuTranslator',revision,license:'GPL-3.0',upstreamSha256,vendoredSha256},null,2)+'\n');
console.log(`Vendored ${seen.size} source files at ${revision}; no weights or fonts.`);
