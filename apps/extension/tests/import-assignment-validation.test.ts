import 'fake-indexeddb/auto';
import {describe,expect,it,vi} from 'vitest';
import {catalog} from '../src/comics/repositories';
import {importImageAlbum,importLocalFile,importSourceFiles,registerDocument} from '../src/comics/application/import-service';
import {listContainerImports} from '../src/storage/containers';

const source={title:'Source document',format:'image' as const,sourceKey:'source:'+crypto.randomUUID(),connectionId:'fixture:reader',provider:'fixture',displayName:'Fixture files',locator:{resource:'image'}};

describe('import destination validation',()=>{
 it('rejects an unnamed new work before copying bytes or changing source authorization',async()=>{
  const file=new File([new Uint8Array([137,80,78,71])],'page.png',{type:'image/png'}),assignment={title:'  ',kind:'chapter' as const};
  const read=vi.spyOn(file,'slice');
  await expect(importLocalFile(file,assignment)).rejects.toThrow('作品名称不能为空');
  await expect(importImageAlbum([file],assignment)).rejects.toThrow('作品名称不能为空');
  await expect(importSourceFiles({connection:{id:'not-installed',provider:'not-installed',displayName:'Unavailable'},files:[]},assignment)).rejects.toThrow('作品名称不能为空');
  await expect(registerDocument(source,assignment)).rejects.toThrow('作品名称不能为空');
  expect(read).not.toHaveBeenCalled();
  expect((await listContainerImports()).items).toHaveLength(0);
  expect(await catalog.list('metadata')).toHaveLength(0);
  expect(await catalog.list('works')).toHaveLength(0);
  expect(await catalog.list('connections')).toHaveLength(0);
 });
 it('allows an existing work without a draft title and preserves an existing unit classification',async()=>{
  const workId=crypto.randomUUID(),unitId=crypto.randomUUID();
  await catalog.put('works',{id:workId,title:'Existing work',createdAt:1,updatedAt:1});
  await catalog.put('units',{id:unitId,workId,title:'Extra volume',kind:'volume',role:'extra',order:1,createdAt:1,updatedAt:1});
  const result=await registerDocument({...source,sourceKey:'existing:'+crypto.randomUUID()},{workId,unitId,title:'',kind:'chapter',role:'main'});
  expect(result.created).toBe(true);
  expect(result.document.unitId).toBe(unitId);
  expect(await catalog.get('units',unitId)).toMatchObject({title:'Extra volume',kind:'volume',role:'extra'});
  expect(await catalog.get('works',workId)).toMatchObject({title:'Existing work'});
 });
});
