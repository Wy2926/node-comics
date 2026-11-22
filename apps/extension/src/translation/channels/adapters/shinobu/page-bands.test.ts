import {expect,it} from 'vitest';
import type {Rect,TextRegion} from '../../../../../third_party/shinobu/packages/image-pipeline/src/types';
import {pageBands,reconcileOverlap,textId} from './page-bands';

const line=(id:string,x:number,y:number,width:number,height:number):TextRegion=>({id,sourceText:'fixture',translatedText:'',box:{x,y,width,height}});
it.each([true,false])('keeps complete seam lines and one-sided detections (vertical=%s)',vertical=>{
  const rect=(start:number):Rect=>vertical?{x:0,y:start,width:600,height:1000}:{x:start,y:0,width:1000,height:600};
  const region=(id:string,at:number,extent:number,lane=15)=>vertical?line(id,lane,at,70,extent):line(id,at,lane,extent,70);
  const a={rect:rect(0),regions:[region('clipped-at-end',970,30),region('full',780,50),region('only-left',928,25,280)]};
  const b={rect:rect(800),regions:[region('full-at-end',170,85),region('clipped-at-start',0,30),region('only-right',100,25,350)]};
  reconcileOverlap(a,b);
  expect([...a.regions,...b.regions].map(r=>r.id).sort()).toEqual(['full','full-at-end','only-left','only-right']);
});
it('covers a 720 × 15000 page at detector scale and preserves normal pages',()=>{
  const bands=pageBands(720,15000);
  expect(bands[0].y).toBe(0);expect(bands.at(-1)!.y+bands.at(-1)!.height).toBe(15000);
  expect(bands.every((b,i)=>b.width===720&&b.height<2048&&(i===0||b.y<bands[i-1].y+bands[i-1].height))).toBe(true);
  expect(pageBands(1200,1800)).toEqual([{x:0,y:0,width:1200,height:1800}]);
});
it('keys a checkpoint by source position and text without ever reading the bubble pixels',()=>{
  const frame={x:0,y:1000,width:720,height:1440},r=line('random',32,8,54,20),key=textId(frame,r,2);
  const next={...r,id:'different',get bubbleMask():never{throw Error('must not serialize masks');}};
  expect(textId(frame,next,2)).toBe(key);
  expect(textId({...frame,y:990},line('shift',32,18,54,20),2)).toBe(key);
  expect(textId(frame,{...r,sourceText:'different'},2)).not.toBe(key);
});
