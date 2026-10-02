import {describe,expect,it} from 'vitest';
import {cropGeometry,sameViewport,validViewport} from '../src/region/geometry';

const viewport={width:1280,height:800,devicePixelRatio:2,scrollX:0,scrollY:300};
describe('screen selection crop coordinates',()=>{
  it('uses actual screenshot dimensions rather than multiplying by devicePixelRatio',()=>{
    expect(cropGeometry({x:100,y:50,width:400,height:200},viewport,1920,1200)).toEqual({
      pixels:{x:150,y:75,width:600,height:300},rect:{x:100,y:50,width:400,height:200},
    });
  });
  it('rounds inward and returns the exact CSS rectangle actually uploaded',()=>{
    const selection={x:10.1,y:20.2,width:30.3,height:40.4},result=cropGeometry(selection,viewport,2560,1600);
    expect(result.pixels).toEqual({x:21,y:41,width:59,height:80});
    expect(result.rect.x).toBeGreaterThanOrEqual(selection.x);
    expect(result.rect.y).toBeGreaterThanOrEqual(selection.y);
    expect(result.rect.x+result.rect.width).toBeLessThanOrEqual(selection.x+selection.width);
    expect(result.rect.y+result.rect.height).toBeLessThanOrEqual(selection.y+selection.height);
  });
  it.each([
    {x:-1,y:0,width:100,height:100},{x:0,y:0,width:Infinity,height:100},
    {x:1200,y:0,width:100,height:100},{x:0,y:750,width:100,height:100},
    {x:0,y:0,width:0,height:100},
  ])('rejects invalid or off-viewport rectangles',rect=>{
    expect(()=>cropGeometry(rect,viewport,2560,1600)).toThrow();
  });
  it('rejects unverified pinch-zoom instead of cropping another visual region',()=>{
    expect(()=>cropGeometry({x:0,y:0,width:100,height:100},{...viewport,visualViewport:{width:640,height:400,offsetLeft:0,offsetTop:0,scale:2}},2560,1600)).toThrow();
  });
  it('invalidates capture when scroll, dimensions, zoom or visual viewport changes',()=>{
    expect(sameViewport(viewport,{...viewport})).toBe(true);
    for(const key of ['width','height','scrollX','scrollY','devicePixelRatio'] as const)
      expect(sameViewport(viewport,{...viewport,[key]:viewport[key]+1})).toBe(false);
    expect(validViewport({...viewport,width:NaN})).toBe(false);
  });
});
