import { describe, expect, it } from 'vitest';
import { anchorFor, scrollAnchorFor, naturalSort } from '../src/reader/model';
import { safeImageUrl } from '../src/sources';
describe('bounded reader and source boundary',()=>{
it('restores relative position across changed image heights',()=>{expect(anchorFor(100,2000,600)).toBe(.25);expect(100+4000*anchorFor(100,2000,600)).toBe(1100);expect(anchorFor(100,0,50)).toBe(0);});
it('preserves chapter gaps and look-ahead offsets outside the selected page',()=>{
  expect(scrollAnchorFor(100,1000,1165)).toEqual({relativeOffset:1,edgeOffset:65});
  expect(scrollAnchorFor(100,1000,60)).toEqual({relativeOffset:0,edgeOffset:-40});
  expect(scrollAnchorFor(100,1000,350)).toEqual({relativeOffset:.25,edgeOffset:0});
  const gap=scrollAnchorFor(100,1000,1165);
  expect(300+2000*gap.relativeOffset+gap.edgeOffset).toBe(2365);
});
it('orders locally imported pages naturally',()=>{expect(naturalSort([{name:'10.png'},{name:'2.png'},{name:'1.png'}]).map(p=>p.name)).toEqual(['1.png','2.png','10.png']);});
it('rejects unsafe schemes and credential-bearing URLs',()=>{expect(safeImageUrl('javascript:alert(1)','https://example.org')).toBeNull();expect(safeImageUrl('https://user:pass@evil.test/a.png','https://example.org')).toBeNull();expect(safeImageUrl('//cdn.example.org/a.png','https://example.org')).toBe('https://cdn.example.org/a.png');});
});
