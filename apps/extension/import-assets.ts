import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {Plugin} from 'vite';

/** Package-local PDF fonts/codecs, also used by the offline MV3 reader. */
export function importAssets():Plugin {
  const root=new URL('./node_modules/pdfjs-dist/',import.meta.url);
  const files=new Map<string,URL>();
  for(const dir of ['cmaps','standard_fonts','wasm']) {
    for(const name of readdirSync(new URL(dir+'/',root))) {
      // No PDF scripting runtime; the reader never executes document actions.
      if(name.startsWith('quickjs'))continue;
      files.set(`import-assets/pdf/${dir}/${name}`,new URL(`${dir}/${name}`,root));
    }
  }
  files.set('import-assets/licenses/pdfjs.txt',new URL('LICENSE',root));
  files.set('import-assets/licenses/zip-js.txt',new URL('./node_modules/@zip.js/zip.js/LICENSE',import.meta.url));
  files.set('import-assets/licenses/node-unrar-js.txt',new URL('./node_modules/node-unrar-js/LICENSE.md',import.meta.url));
  for(const [name,file] of Object.entries({'pdf-lib':'pdf-lib/LICENSE.md','pdf-lib-standard-fonts':'@pdf-lib/standard-fonts/LICENSE.md','pdf-lib-upng':'@pdf-lib/upng/LICENSE','pdf-lib-pako':'pako/LICENSE','pdf-lib-zlib':'pako/lib/zlib/README','pdf-lib-tslib':'tslib/LICENSE.txt'})) {
    files.set(`import-assets/licenses/${name}.txt`,new URL('./node_modules/'+file,import.meta.url));
  }
  return {name:'local-comic-import-assets',
    configureServer(server){server.middlewares.use((req,res,next)=>{
      const file=files.get((req.url??'').split('?')[0].replace(/^\//,''));
      if(!file)return next();
      res.setHeader('Content-Type',file.pathname.endsWith('.wasm')?'application/wasm':file.pathname.endsWith('.js')?'text/javascript':'application/octet-stream');
      res.end(readFileSync(fileURLToPath(file)));
    });},
    generateBundle(){for(const [fileName,url] of files)this.emitFile({type:'asset',fileName,source:readFileSync(url)});},
  };
}
