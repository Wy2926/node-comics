/** Synthetic-only slow image server. Generate inputs with generate_reader_streaming_fixture.py. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const directory=resolve(process.argv[2]??'artifacts/reader-streaming');
const names=['progressive.jpg','baseline.jpg','plain.png','plain.webp'];
const assets=new Map(await Promise.all(names.map(async name=>[name,await readFile(resolve(directory,name))])));
const runs=new Map();
createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:5211'),run=url.searchParams.get('run')??'manual';
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:5181');res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Cache-Control','no-store');
 if(url.pathname==='/metrics'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(runs.get(run)??[]));return;}
 const name=url.pathname.slice(1),data=assets.get(name);if(!data){res.writeHead(404).end();return;}
 if(!runs.has(run)){if(runs.size>=20)runs.delete(runs.keys().next().value);runs.set(run,[]);}
 const records=runs.get(run),page=url.searchParams.get('page')??'1';
 const fault=url.searchParams.has('fault')&&!records.some(record=>record.page===page);
 const record={page,format:name,bytes:0,complete:false,cancelled:false};records.push(record);
 const kib=Math.max(0,Math.min(4096,Number(url.searchParams.get('kib')??128))),size=16384;
 res.writeHead(200,{'Content-Type':name.endsWith('png')?'image/png':name.endsWith('webp')?'image/webp':'image/jpeg','Content-Length':data.length});
 let timer;const write=()=>{
  if(fault&&record.bytes>=data.length/4){res.destroy();return;}
  const end=kib?Math.min(data.length,record.bytes+size):data.length;
  res.write(data.subarray(record.bytes,end));record.bytes=end;
  if(record.bytes===data.length){record.complete=true;clearInterval(timer);res.end();}
 };
 if(kib)timer=setInterval(write,Math.max(1,1000*size/(kib*1024)));else write();
 res.on('close',()=>{clearInterval(timer);record.cancelled=!record.complete;});
}).listen(5211,'127.0.0.1',()=>console.log('Reader synthetic images: http://127.0.0.1:5211 (default 128 KiB/s)'));
