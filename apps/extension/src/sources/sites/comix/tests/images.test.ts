import {describe,expect,it,vi,afterEach} from 'vitest';
import {decodeImage} from '../images';

// Draw destinations observed from the site's decoder for chapter 6887743.
const cases=[
  {hash:'02900',seed:'1876440565',order:[20,18,8,7,15,4,13,12,23,1,10,16,9,22,24,5,0,17,6,2,11,19,3,14,21]},
  {hash:'03632',seed:'3167908534',order:[12,1,2,20,11,10,23,19,16,24,14,18,8,17,7,21,4,15,9,3,13,5,6,22,0]},
  {hash:'72103',seed:'1545210582',order:[14,23,10,11,3,19,5,17,4,15,6,9,8,21,7,13,18,22,24,2,12,16,1,0,20]},
];
afterEach(()=>vi.unstubAllGlobals());
describe('Comix image response variants',()=>{
  it.each(cases)('restores the source tile order for hash $hash',async({hash,seed,order})=>{
    const bitmap={width:940,height:967,close:vi.fn()},drawImage=vi.fn(),output=new Blob(['decoded'],{type:'image/png'});
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>bitmap));
    vi.stubGlobal('OffscreenCanvas',class {
      getContext(){return {drawImage};}
      async convertToBlob(){return output;}
    });
    const headers=new Headers({'X-Scramble-Seed':seed,'X-Scramble-Grid':'5x5','X-Scramble-Algo':'3','X-Scramble-Hash':hash});
    expect(await decodeImage(new Blob(),headers,'tiles-v1')).toBe(output);
    expect(drawImage.mock.calls[0]).toEqual([bitmap,0,0]);
    expect(drawImage.mock.calls.slice(1)).toEqual(order.map((to,from)=>[bitmap,from%5*188,Math.floor(from/5)*193,188,193,to%5*188,Math.floor(to/5)*193,188,193]));
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('keeps ordinary images unchanged',async()=>{
    const blob=new Blob(['original']);expect(await decodeImage(blob,new Headers())).toBe(blob);
  });
  it.each([{seed:'1',grid:'5x5',algo:'4'},{seed:'4294967296',grid:'5x5',algo:'3'},{seed:'1',grid:'',algo:'3'}])('still rejects invalid protocol headers: %j',async({seed,grid,algo})=>{
    await expect(decodeImage(new Blob(),new Headers({'X-Scramble-Seed':seed,'X-Scramble-Grid':grid,'X-Scramble-Algo':algo}),'tiles-v1')).rejects.toThrow('协议已变化');
  });
});
