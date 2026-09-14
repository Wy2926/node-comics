import {describe,it,expect} from 'vitest';
import {anchorFor,naturalSort} from '../src/reader/model';
import {safeImageUrl} from '../src/sources/adapters';
describe('bounded reader and source boundary',()=>{
it('restores relative position across changed image heights',()=>{expect(anchorFor(100,2000,600)).toBe(.25);expect(100+4000*anchorFor(100,2000,600)).toBe(1100);expect(anchorFor(100,0,50)).toBe(0);});
it('orders locally imported pages naturally',()=>{expect(naturalSort([{name:'10.png'},{name:'2.png'},{name:'1.png'}]).map(p=>p.name)).toEqual(['1.png','2.png','10.png']);});
it('rejects unsafe schemes and credential-bearing URLs',()=>{expect(safeImageUrl('javascript:alert(1)','https://example.org')).toBeNull();expect(safeImageUrl('https://user:pass@evil.test/a.png','https://example.org')).toBeNull();expect(safeImageUrl('//cdn.example.org/a.png','https://example.org')).toBe('https://cdn.example.org/a.png');});
});
