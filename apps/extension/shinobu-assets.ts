import {readFileSync} from 'node:fs';
import type {Plugin} from 'vite';
export function shinobuAssets():Plugin{
  const files=new Map<string,URL>();
  files.set('local-runtime/font-coverage.json',new URL('./src/translation/font-coverage.json',import.meta.url));
  for(const name of ['ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm'])files.set('local-runtime/'+name,new URL('./node_modules/onnxruntime-web/dist/'+name,import.meta.url));
  files.set('local-runtime/LICENSE-onnxruntime.txt',new URL('./third_party/shinobu/LICENSE-onnxruntime.txt',import.meta.url));
  files.set('local-runtime/LICENSE-shinobu.txt',new URL('./third_party/shinobu/LICENSE',import.meta.url));
  files.set('local-runtime/LICENSE-comlink.txt',new URL('./third_party/shinobu/LICENSE-comlink.txt',import.meta.url));
  files.set('local-runtime/THIRD_PARTY_NOTICES.md',new URL('./third_party/shinobu/THIRD_PARTY_NOTICES.md',import.meta.url));
  for(const name of ['INTEGRATION.md','provenance.json','runtime-provenance.json'])files.set('local-runtime/'+name,new URL('./third_party/shinobu/'+name,import.meta.url));
  for(const name of ['manifest.json','publication-policy.json'])files.set('local-runtime/models-'+name,new URL('./third_party/shinobu/packages/model-manifest/'+name,import.meta.url));
  return {name:'shinobu-local-runtime',configureServer(server){server.middlewares.use((request,response,next)=>{
    const name=request.url?.split('?')[0].replace(/^\//,'')??'',file=files.get(name);if(!file)return next();
    response.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':name.endsWith('.mjs')?'text/javascript':'text/plain');response.end(readFileSync(file));
  });},generateBundle(){for(const [fileName,url] of files)this.emitFile({type:'asset',fileName,source:readFileSync(url)});}};
}
