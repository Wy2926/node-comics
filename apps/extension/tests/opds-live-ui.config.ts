import {Readable} from 'node:stream';
import {defineConfig,mergeConfig} from 'vite';
import base from '../vite.config';

/** UI-only relay for the public demo's CORS restriction. No fixtures or fabricated responses.
 * Production MV3 networking is separately verified by scripts/verify_opds_live.mjs.
 * Loopback only, fixed upstream, read-only methods, no redirects or product API traffic.
 */
export default mergeConfig(base,defineConfig({server:{host:'127.0.0.1',port:5197,strictPort:true},plugins:[{
  name:'live-opds-ui',
  transformIndexHtml(html){return html.replace('src="/src/main.tsx"','src="/tests/opds-live-ui.ts"');},
  configureServer(server){server.middlewares.use('/__opds_live',async(req,res)=>{
    try{
      const target=new URL(new URL(req.url??'/','http://127.0.0.1').searchParams.get('url')??'');
      if(target.origin!=='https://demo.komga.org'||!['GET','HEAD'].includes(req.method??'')||
        !target.pathname.startsWith('/opds/')&&!target.pathname.startsWith('/api/v1/books/')){res.statusCode=403;res.end('Live demo read-only scope');return;}
      const headers=new Headers();
      for(const name of ['authorization','accept','range','if-match','if-range']){const value=req.headers[name];if(typeof value==='string')headers.set(name,value);}
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const response=await fetch(target,{method:req.method,headers,redirect:'manual',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])});
      res.statusCode=response.status;
      for(const name of ['content-type','etag','accept-ranges','content-range','retry-after']){const value=response.headers.get(name);if(value)res.setHeader(name,value);}
      // Node fetch decodes transfer content; do not forward compressed Content-Length/Encoding.
      res.setHeader('Cache-Control','no-store');
      if(response.body)Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).on('error',()=>res.destroy()).pipe(res);
      else res.end();
    }catch{if(!res.headersSent){res.statusCode=502;res.end('Public OPDS demo unavailable');}else res.destroy();}
  });},
}]}));
