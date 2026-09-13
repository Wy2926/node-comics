import { describe, expect, it } from 'vitest';
import { decompressPalmDoc, importMobi } from './mobi';

function mobi({encrypted = false, refs = [2,1], badOffset = false} = {}) {
  const header = new Uint8Array(78 + 4 * 8);
  header.set(new TextEncoder().encode('BOOKMOBI'), 60);
  const h = new DataView(header.buffer); h.setUint16(76, 4);
  const record0 = new Uint8Array(248); const r = new DataView(record0.buffer);
  r.setUint16(0,1); r.setUint16(8,1); r.setUint16(12,encrypted?1:0);
  record0.set(new TextEncoder().encode('MOBI'),16); r.setUint32(20,232); r.setUint32(36,6); r.setUint32(108,2);
  const text = new TextEncoder().encode(refs.map(n => `<img recindex="${n}">`).join(''));
  const png = (width:number) => {const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);new DataView(bytes.buffer).setUint32(16,width);new DataView(bytes.buffer).setUint32(20,100);return bytes;};
  const records = [record0,text,png(200),png(300)];
  let offset=header.length; records.forEach((rec,i)=>{h.setUint32(78+i*8,badOffset && i===2?1:offset);offset+=rec.length;});
  return new File([header,...records], 'comic.mobi');
}

describe('bounded local MOBI import',()=> {
  it('uses body image order, independent from physical resource order',async()=> {
    const result=await importMobi(mobi()); expect(result.pages.map(p=>p.width)).toEqual([300,200]);
    expect(result.pages[0].blob.type).toBe('image/png');
  });
  it('rejects DRM before extracting images',async()=> {await expect(importMobi(mobi({encrypted:true}))).rejects.toThrow('DRM');});
  it('rejects record offset corruption',async()=> {await expect(importMobi(mobi({badOffset:true}))).rejects.toThrow('记录表');});
  it('rejects missing image references',async()=> {await expect(importMobi(mobi({refs:[99]}))).rejects.toThrow('不存在');});
  it('rejects text backreference before buffer',()=>{expect(()=>decompressPalmDoc(Uint8Array.from([128,24]))).toThrow('回溯');});
  it('decodes PalmDOC literals, spaces and overlapping backreferences',()=> {
    expect(new TextDecoder().decode(decompressPalmDoc(Uint8Array.from([97,98,99,128,25,225])))).toBe('abcabca a');
  });
});
