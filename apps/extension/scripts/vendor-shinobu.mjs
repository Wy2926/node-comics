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
const aliases=new Map();
for(const name of ['image-pipeline','model-runtime','browser-runtime','translator-core','text-translation','diagnostics']){
  const pkg=JSON.parse(fs.readFileSync(path.join(source,'packages',name,'package.json'),'utf8'));
  for(const [key,value] of Object.entries(pkg.exports))aliases.set(`@shinobu/${name}${key==='.'?'':key.slice(1)}`,path.join('packages',name,typeof value==='string'?value:value.default));
}
const pending=['packages/image-pipeline/src/index.ts','packages/model-runtime/src/browser.ts','packages/model-runtime/src/workers/onnx-worker.ts','apps/web/src/runtime/offscreenPlatform.ts'];
const seen=new Set(),hashes={};
const resolve=filename=>['', '.ts','/index.ts'].map(suffix=>filename+suffix).find(value=>fs.existsSync(path.join(source,value))&&fs.statSync(path.join(source,value)).isFile());
while(pending.length){
  const file=pending.pop();if(seen.has(file))continue;seen.add(file);
  const original=fs.readFileSync(path.join(source,file),'utf8');
  hashes[file]=crypto.createHash('sha256').update(original).digest('hex');
  let content=original;
  // The benchmark barrel includes browser-only alternatives; the platform needs only structural types.
  if(file.endsWith('offscreenPlatform.ts'))content=content.replace('@shinobu/image-pipeline/benchmark','@shinobu/image-pipeline');
  // The host supplies text translation. Keep its contract/provider guard, not unused HTTP clients.
  if(file==='packages/text-translation/src/index.ts')content="export * from './contracts';\nexport { isLlmProvider } from './providerCatalog';\n";
  content=content.replace(/(['"])(@shinobu\/[^'"]+|\.{1,2}\/[^'"]+)\1/g,(match,quote,spec)=>{
    const target=aliases.get(spec)??resolve(path.normalize(path.join(path.dirname(file),spec)));
    if(!target)return match;
    pending.push(target);
    let relative=path.relative(path.dirname(file),target).replace(/\.ts$/,'');
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
  if(file.endsWith('image-pipeline/src/index.ts'))content=content.replace('if (!retry.retryable) throw error;',"if (retryOperation.stage === 'translate' || !retry.retryable) throw error;");
  content=content.replace('constructor(readonly reason: PipelineCancellationReason)', 'constructor(override readonly reason: PipelineCancellationReason)').replace('    readonly failure: PipelineFailureEnvelope,','    override readonly failure: PipelineFailureEnvelope,');
  if(file.endsWith('pipeline/detect/index.ts'))content=content.replace("| { kind: 'heuristic-only' }","| { kind: 'strict' }\n  | { kind: 'heuristic-only' }").replace('} catch (error) {','} catch (error) {\n    if (fallbackStrategy.kind === \'strict\') throw error;');
  if(file.endsWith('pipeline/image.ts'))content=content.replace(/\(globalThis as \{ __shinobuColdStartImageBlobUrl\?: boolean \}\)\.__shinobuColdStartImageBlobUrl === true\s*&& /,'');
  if(file.endsWith('typeset/fontRuntime.ts'))content=`import type {PlatformProvider} from '../../runtime/platform';
// One selected, verified font per isolated pipeline Worker, shared by measurement and rendering.
export let TYPESET_FONT_WEIGHT=400;
let selectedFamily='';
export function configureTypesetFont(family:string,weight:number){selectedFamily=family;TYPESET_FONT_WEIGHT=weight;}
export function resolveTypesetFontFamily(_targetLang?:string):string {
  if(!selectedFamily)throw Error('Font not configured');
  return JSON.stringify(selectedFamily);
}
export function registerTypesetFonts(platform:PlatformProvider,resolve:(path:string)=>string,_targetLang?:string){
  platform.registerFont(resolve('selected-font'),selectedFamily,{style:'normal',weight:String(TYPESET_FONT_WEIGHT)});
}
export function formatTypesetFont(size:number,family:string){return TYPESET_FONT_WEIGHT+' '+size+'px '+family;}
`;
  const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
}
for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md','packages/model-manifest/manifest.json','packages/model-manifest/publication-policy.json','public/models/models.json']){
  const target=path.join(destination,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,file),target);
  hashes[file]=crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}
const vendoredSha256=Object.fromEntries(Object.keys(hashes).map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(destination,file))).digest('hex')]));
for(const file of Object.keys(previous))if(file.endsWith('.ts')&&!seen.has(file))fs.rmSync(path.join(destination,file),{force:true});
fs.writeFileSync(path.join(destination,'provenance.json'),JSON.stringify({source:'https://github.com/DonutShinobu/ShinobuTranslator',revision,license:'GPL-3.0',upstreamSha256:hashes,vendoredSha256},null,2)+'\n');
console.log(`Vendored ${seen.size} source files at ${revision}; no weights or fonts.`);
