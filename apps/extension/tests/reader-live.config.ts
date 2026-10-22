import {defineConfig,mergeConfig} from 'vite';
import base from '../vite.config';
import {createReaderLiveHandler,liveOrigin} from './reader-live-server';

// npx vite --config tests/reader-live.config.ts
// http://127.0.0.1:5199/tests/reader-live.html (or ?sample=translations)
export default mergeConfig(base,defineConfig({
  server:{host:'127.0.0.1',port:5199,strictPort:true},
  plugins:[{name:'reader-live-public-source',configureServer(server){
    const handle = createReaderLiveHandler(async()=>
      (await server.ssrLoadModule('/src/sources/sites/asurascans/network.ts')).network);
    server.middlewares.use('/__reader_live',async(req,res)=>{
      if (req.headers.host!=='127.0.0.1:5199') {res.statusCode=403;res.end('Loopback only');return;}
      const controller = new AbortController();
      res.on('close',()=>controller.abort());
      try {
        const response = await handle(new Request(liveOrigin+'/__reader_live'+(req.url??'/'),{
          method:req.method,signal:controller.signal,headers:{...(req.headers.origin?{Origin:req.headers.origin}:{})},
        }));
        res.statusCode=response.status;
        response.headers.forEach((value,name)=>res.setHeader(name,value));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch { if (!res.headersSent) {res.statusCode=502;res.end('Live reader request failed');} else res.destroy(); }
    });
  }}],
}));
