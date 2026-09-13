import fs from 'node:fs/promises';
import path from 'node:path';
import { importMobi } from '../apps/extension/src/importers/mobi.ts';
const root = path.resolve(import.meta.dirname, '..');
const files = await fs.readdir(path.join(root,'临时资源'));
const name = files.find(n=>n.endsWith('.mobi'));
if (!name) throw new Error('No local MOBI fixture');
const start = performance.now();
const blob = await (await import('node:fs')).openAsBlob(path.join(root,'临时资源',name));
const result = await importMobi(new File([blob],name));
const report = { fileBytes:blob.size,pageCount:result.pages.length,firstPage:{width:result.pages[0].width,height:result.pages[0].height},
  lastPage:{width:result.pages.at(-1).width,height:result.pages.at(-1).height},
  totalImageBytes:result.pages.reduce((n,p)=>n+p.blob.size,0),elapsedMs:Math.round(performance.now()-start),
  warnings:result.warnings,ordering:'MOBI6 body recindex references',noImageDecode:true };
await fs.writeFile(path.join(root,'docs/evidence/mobi-import.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
