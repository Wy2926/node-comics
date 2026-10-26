import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {describe,expect,it} from 'vitest';
import {fixFlipbookClip,flipbookClip} from '../flipbook-clip';

const path=createRequire(import.meta.url).resolve('@gullabs/flipbook-core').replace(/index\.cjs$/,'index.js');
const original=readFileSync(path,'utf8');
// Test the installed engine's real calculation, without exporting a private
// engine API to production or duplicating its geometry in a mock.
const file=ts.createSourceFile(path,original,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
let name='';
function find(node:ts.Node){
 if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isClassExpression(node.initializer)&&node.initializer.members.some(member=>member.name?.getText(file)==='getBottomClipArea'))name=node.name.getText(file);
 ts.forEachChild(node,find);
}
find(file);
const expose=(code:string)=>`data:text/javascript;base64,${Buffer.from(`${code}\nexport {${name} as Calculation};`).toString('base64')}`;
const {Calculation}=await import(/* @vite-ignore */expose(fixFlipbookClip(original)));
type Point={x:number;y:number};
const area=(points:Point[])=>Math.abs(points.reduce((total,p,n)=>{const next=points[(n+1)%points.length];return total+p.x*next.y-next.x*p.y;},0)/2);

describe('library small-corner reveal',()=>{
 it('applies the same fix to builds and versioned development URLs',()=>{
  const transform=flipbookClip().transform as (code:string,id:string)=>{code:string}|undefined;
  expect(transform(original,path)?.code).toBe(fixFlipbookClip(original));
  expect(transform(original,`${path}?v=test`)?.code).toBe(fixFlipbookClip(original));
  expect(transform(original,'/src/reader.ts')).toBeUndefined();
 });
 it.each([0,1])('reveals a bottom triangle before the fold reaches the top, direction %s',direction=>{
  const fold=new Calculation(direction,'bottom',200,300);
  expect(fold.calc({x:160,y:270})).toBe(true);
  const points=fold.getBottomClipArea().filter(Boolean) as Point[];
  expect(points.length).toBeGreaterThanOrEqual(3);
  expect(area(points)).toBeGreaterThan(0);
  expect(area(points)).toBeLessThan(200*300*.1);
 });
 it.each(['top','bottom'])('keeps valid revealed areas across %s-corner drag positions',corner=>{
  const fold=new Calculation(0,corner,400,600);
  for(const fraction of [.05,.15,.28,.49,.65,.9]){
   expect(fold.calc({x:400-800*fraction,y:corner==='top'?60:540})).toBe(true);
   const points=fold.getBottomClipArea().filter(Boolean) as Point[];
   expect(area(points)).toBeGreaterThan(0);
   expect(area(points)).toBeLessThanOrEqual(400*600+1);
   expect(points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))).toBe(true);
  }
 });
 it('refuses changed, missing, duplicate or already-patched upstream methods',()=>{
  expect(()=>fixFlipbookClip('')).toThrow(/changed/);
  expect(()=>fixFlipbookClip(original+original)).toThrow(/changed/);
  expect(()=>fixFlipbookClip(original.replace('getBottomClipArea(){','getBottomClipArea(){ '))).toThrow(/changed/);
  expect(()=>fixFlipbookClip(fixFlipbookClip(original))).toThrow(/changed/);
 });
});
