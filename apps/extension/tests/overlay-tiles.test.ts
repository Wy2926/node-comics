import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {readTiles,TILES_MIME} from '../../../backend/shared/translation-images/tiles';

const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const image='a'.repeat(64),bytes=new TextEncoder().encode('frozen WebP bytes');
function container(change:Record<string,unknown>={},extra=false){
  const tile={x:1,y:1,width:2,height:2,byte_size:bytes.length,sha256:sha(bytes),...change};
  const manifest=new TextEncoder().encode(JSON.stringify({format:'overlay-tiles-v1',input_sha256:image,width:10,height:10,tiles:extra?[tile,tile]:[tile]}));
  const header=new Uint8Array(12);header.set(new TextEncoder().encode('NCOT0001'));new DataView(header.buffer).setUint32(8,manifest.length,true);
  return new Blob([header,manifest,bytes,...(extra?[bytes]:[])],{type:TILES_MIME});
}
describe('bounded frozen WebP tile artifacts',()=>{
  it('reads slices at their native coordinates and checks their independent hashes',async()=>{
    const tiles=await readTiles(container(),image,10,10);
    expect(tiles).toHaveLength(1);expect(tiles[0]).toMatchObject({x:1,y:1,width:2,height:2});
    expect(tiles[0].blob.type).toBe('image/webp');expect(await tiles[0].blob.text()).toBe('frozen WebP bytes');
  });
  it.each([{x:-1},{x:9},{width:2049},{height:4097},{byte_size:bytes.length+1},{sha256:'b'.repeat(64)}])('rejects invalid geometry and exact byte descriptors %j',async change=>{
    await expect(readTiles(container(change),image,10,10)).rejects.toThrow();
  });
  it('rejects overlapping patches and another page identity',async()=>{
    await expect(readTiles(container({},true),image,10,10)).rejects.toThrow('Overlapping');
    await expect(readTiles(container(),'b'.repeat(64),10,10)).rejects.toThrow('identity');
    await expect(readTiles(container(),image,10,11)).rejects.toThrow('identity');
  });
});
