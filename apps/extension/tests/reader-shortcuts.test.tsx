import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
import type {ReadingEntry} from '../src/types';
import type {ReadingView} from '../src/reader/view';

// Exercise the actual reader command callbacks without images, browser layout, or a translation service.
const hooks=vi.hoisted(()=>({cursor:0,states:[] as unknown[],effects:[] as (()=>void|(()=>void))[],handlers:{} as Record<string,()=>void|boolean>,enabled:true}));
const actions=vi.hoisted(()=>({preserve:vi.fn(),persist:vi.fn(),restore:vi.fn(),jump:vi.fn(),requestTranslation:vi.fn(),track:vi.fn()}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useState:<T,>(initial?:T|(()=>T))=>{
  const index=hooks.cursor++;
  if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?(initial as ()=>T)():initial;
  return [hooks.states[index],(next:T|((value:T)=>T))=>{hooks.states[index]=typeof next==='function'?(next as (value:T)=>T)(hooks.states[index] as T):next;}];
 },
 useRef:(current:unknown)=>({current}),useMemo:(compute:()=>unknown)=>compute(),useEffect:(effect:()=>void|(()=>void))=>{hooks.effects.push(effect);},useLayoutEffect:()=>{},
}));
vi.mock('../src/shortcuts/react',()=>({useShortcuts:(handlers:typeof hooks.handlers,options:{enabled:boolean})=>{hooks.handlers=handlers;hooks.enabled=options.enabled;}}));
vi.mock('../src/reader/useReaderAnalytics',()=>({useReaderAnalytics:()=>({requestTranslation:actions.requestTranslation})}));
vi.mock('../src/analytics',()=>({track:actions.track}));
vi.mock('../src/reader/useChapterStream',()=>({
 pageKey:(copy:ReadingEntry,pageId:string)=>`${copy.id}:${pageId}`,completeManifest:()=>true,
 useChapterStream:({copy}:{copy:ReadingEntry})=>({
  index:2,indexRef:{current:2},readingAhead:4,viewport:{current:null},cells:{current:new Map()},ends:{current:new Map()},stacks:{current:new Map()},geometry:{current:new Map()},
  stream:[copy],next:undefined,nextOf:()=>undefined,...actions,scroll:()=>{},navigationReason:{current:'direct'},pageShown:()=>{},resources:{ready:()=>true},resourceVersion:0,
 }),
}));
import {Reader} from '../src/reader/Reader';
import {ReaderShell, ReaderDrawer, ReaderNavigation, ReaderSettingsButton, ReaderTools} from '../src/reader/ReaderChrome';
import {ReaderSettings, ReaderScale, ReaderChoice, ReaderTranslationSettings} from '../src/reader/ReaderSettings';
import {defaults} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';

type Props=Parameters<typeof Reader>[0];
const copy:ReadingEntry={id:'reader-fixture',title:'Fixture',source:'zip',sourceKey:'fixture',generation:1,createdAt:0,updatedAt:0,pageId:'page-2',relativeOffset:.35,discoveryComplete:true,
 pages:Array.from({length:5},(_,index)=>({id:`page-${index}`,name:`Page ${index+1}`,width:1000,height:1500,jobs:[],outputBlobs:{}}))};
function fixture(extra:Partial<Props>={}){
 const props:Props={
  viewKey:'fixture',copy,sequence:[copy],settings:{...defaults},setSettings:vi.fn(),update:vi.fn(),onBack:vi.fn(),onOpenShortcuts:vi.fn(),onRetry:vi.fn(),onFind:vi.fn(),
  onUpgrade:vi.fn(),onLogin:vi.fn(),onImport:vi.fn(),notify:vi.fn(),onMarkRead:vi.fn(async()=>{}),onNavigate:vi.fn(),onActiveEntry:vi.fn(),onLoadEntry:vi.fn(),
  onReadingWindow:vi.fn(),translationState:vi.fn(),api:{} as Props['api'],busy:false,...extra,
 };
 props.setSettings=vi.fn(next=>{props.settings=typeof next==='function'?next(props.settings):next;});
 return props;
}
function render(props:Props){hooks.cursor=0;hooks.effects=[];return Reader(props);}
function view(){return hooks.states.find((value):value is ReadingView=>!!value&&typeof value==='object'&&'zoom' in value)!;}
function nodes(node:unknown):ReactElement<Record<string,unknown>>[]{
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!node||typeof node!=='object'||!('props' in node))return [];
 const element=node as ReactElement<Record<string,unknown>>;
 if([ReaderShell,ReaderDrawer,ReaderNavigation,ReaderSettingsButton,ReaderTools,ReaderSettings,ReaderScale,ReaderChoice,ReaderTranslationSettings].includes(element.type as never))return [element,...nodes((element.type as (props:Record<string,unknown>)=>unknown)(element.props))];
 return [element,...nodes(element.props.children)];
}
function click(tree:ReactElement,match:(node:ReactElement<Record<string,unknown>>)=>boolean){
 const node=nodes(tree).find(match);expect(node).toBeDefined();(node!.props.onClick as ()=>void)();
}
beforeEach(()=>{
 hooks.states=[];hooks.cursor=0;hooks.handlers={};hooks.enabled=true;
 for(const action of Object.values(actions))action.mockClear();
 installDictionary('zh-CN',{});
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});
});
afterEach(()=>vi.unstubAllGlobals());

describe('reader shortcut action integration',()=>{
 it.each(['ltr','rtl'] as const)('uses reading direction only for left/right, not previous/next (%s)',direction=>{
  render(fixture({settings:{...defaults,direction}}));
  hooks.handlers['reader.left']();hooks.handlers['reader.right']();hooks.handlers['reader.previous']();hooks.handlers['reader.next']();hooks.handlers['reader.first']();hooks.handlers['reader.last']();
  expect(actions.jump.mock.calls.map(([page])=>page)).toEqual(direction==='rtl'?[3,1,1,3,0,4]:[1,3,1,3,0,4]);
 });
 it('switches viewing choice and comparison through the existing position-preserving path without retrying a task',()=>{
  const props=fixture();render(props);
  hooks.handlers['reader.translation']();expect(view().preference).toBe('translation');expect(actions.preserve).toHaveBeenCalledTimes(1);
  const translated=render(props);expect(nodes(translated).some(node=>node.props.selectedView==='classic')).toBe(true);
  hooks.handlers['reader.compare']();expect(view().preference).toBe('translation');
  expect(nodes(render(props)).some(node=>node.props.className==='nc-page-picture comparison')).toBe(true);
  hooks.handlers['reader.original']();expect(view().preference).toBe('original');
  expect(nodes(render(props)).some(node=>node.props.className==='nc-page-picture comparison')).toBe(false);
  expect(actions.preserve).toHaveBeenCalledTimes(3);expect(props.onRetry).not.toHaveBeenCalled();
 });
 it('does not activate a disabled translation mode from the keyboard',()=>{
  const props=fixture({caps:{modes:[{id:'classic',label:'Classic',enabled:false}],languages:[],limits:{max_bytes:1,max_pixels:1,max_dimension:1,max_translation_ids:1},entitlements:null}});
  render(props);expect(hooks.handlers['reader.translation']()).toBe(false);expect(hooks.handlers['reader.compare']()).toBe(false);
  expect(view().preference).toBe('original');expect(actions.preserve).not.toHaveBeenCalled();expect(props.onRetry).not.toHaveBeenCalled();
 });
 it('bounds repeated zoom keys, resets to 100%, and keeps the comic viewing preference',()=>{
  render(fixture());
  for(let index=0;index<15;index++)hooks.handlers['reader.zoomIn']();
  expect(view()).toEqual({mode:'classic',preference:'original',zoom:200});
  for(let index=0;index<25;index++)hooks.handlers['reader.zoomOut']();
  expect(view().zoom).toBe(40);hooks.handlers['reader.zoomReset']();expect(view().zoom).toBe(100);
  expect(actions.preserve).toHaveBeenCalledTimes(41);
 });
 it('changes layout and fit through the same preserving controls while retaining unrelated settings',()=>{
  const props=fixture();render(props);hooks.handlers['reader.layout']();hooks.handlers['reader.fit']();
  expect(props.settings).toEqual({...defaults,layout:'single',fit:'width'});
  expect(actions.preserve).toHaveBeenCalledTimes(2);
  expect(actions.preserve.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props.setSettings).mock.invocationCallOrder[0]);
  render(props);hooks.handlers['reader.layout']();hooks.handlers['reader.fit']();expect(props.settings).toEqual(defaults);
 });
 it('shares drawer controls and replaces the old help modal with the app-owned panel',()=>{
  const props=fixture();render(props);hooks.handlers['reader.directory']();
  expect(nodes(render(props)).some(node=>node.props['aria-label']==='漫画目录')).toBe(true);
  hooks.handlers['reader.settings']();const settings=render(props);
  expect(nodes(settings).some(node=>node.props['aria-label']==='阅读设置'&&node.type==='aside')).toBe(true);
  click(settings,node=>node.type==='button'&&nodes(node).some(child=>child.props.name==='keyboard'));
  expect(props.onOpenShortcuts).toHaveBeenCalledOnce();
  const after=render(props);expect(nodes(after).some(node=>node.type==='aside'||node.type==='dialog')).toBe(false);
 });
 it('preserves and persists before leaving or finding alternate languages',()=>{
  const props=fixture();render(props);hooks.handlers['reader.back']();hooks.handlers['reader.find']();
  expect(actions.preserve).toHaveBeenCalledTimes(2);expect(actions.persist).toHaveBeenCalledTimes(2);
  expect(actions.persist.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(props.onBack).mock.invocationCallOrder[0]);
  expect(props.onFind).toHaveBeenCalledOnce();
  render(fixture({onFind:undefined}));expect(hooks.handlers['reader.find']()).toBe(false);
 });
 it.each([{searchOpen:true},{analyticsBlocked:true}])('disables reader commands beneath another active surface: %j',extra=>{
  render(fixture(extra));expect(hooks.enabled).toBe(false);
 });
 it('keeps navigation and translation inactive without pages while allowing reader settings',()=>{
  const props=fixture({copy:{...copy,pages:[]}});render(props);
  for(const command of ['previous','next','left','right','first','last','original','translation','compare','zoomIn','zoomOut','zoomReset','translationSettings'])expect(hooks.handlers[`reader.${command}`]()).toBe(false);
  expect(actions.jump).not.toHaveBeenCalled();expect(actions.preserve).not.toHaveBeenCalled();
  hooks.handlers['reader.settings']();expect(nodes(render(props)).some(node=>node.type==='aside')).toBe(true);
 });
 it('reports fullscreen API failures without an unhandled rejection',async()=>{
  const requestFullscreen=vi.fn().mockRejectedValue(new Error('Unavailable'));
  vi.stubGlobal('document',{fullscreenElement:null,documentElement:{requestFullscreen}});
  const props=fixture();render(props);hooks.handlers['reader.fullscreen']();await Promise.resolve();
  expect(requestFullscreen).toHaveBeenCalledOnce();expect(props.notify).toHaveBeenCalledWith('此浏览器暂时无法进入全屏。');
 });
 it.each([
  {modal:true,analyticsBlocked:false,event:{}},
  {modal:false,analyticsBlocked:true,event:{}},
  {modal:false,analyticsBlocked:false,event:{isComposing:true}},
  {modal:false,analyticsBlocked:false,event:{keyCode:229}},
  {modal:false,analyticsBlocked:false,event:{defaultPrevented:true}},
 ])('does not let the translation popover steal Escape from an upper surface or input: %j',({modal,analyticsBlocked,event})=>{
  const documentListeners=vi.fn();
  vi.stubGlobal('document',{querySelector:()=>modal?{}:null,addEventListener:documentListeners,removeEventListener:vi.fn()});
  vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture();render(props);hooks.handlers['reader.translationSettings']();props.analyticsBlocked=analyticsBlocked;render(props);
  const cleanups=hooks.effects.map(effect=>effect());
  const escape=documentListeners.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
  const input={key:'Escape',defaultPrevented:false,isComposing:false,keyCode:27,preventDefault:vi.fn(),stopPropagation:vi.fn(),...event};
  escape(input as unknown as KeyboardEvent);
  expect(input.preventDefault).not.toHaveBeenCalled();expect(input.stopPropagation).not.toHaveBeenCalled();
  expect(nodes(render(props)).some(node=>node.type==='aside'&&node.props['aria-label']==='翻译选项')).toBe(true);
  for(const cleanup of cleanups)cleanup?.();
 });
 it('keeps Escape dismissal and trigger focus for the active translation popover',()=>{
  const documentListeners=vi.fn(),focus=vi.fn();
  vi.stubGlobal('document',{querySelector:()=>null,addEventListener:documentListeners,removeEventListener:vi.fn()});
  vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture();render(props);hooks.handlers['reader.translationSettings']();const tree=render(props);
  (tree.props.ref as {current:unknown}).current={querySelector:(selector:string)=>selector==='.nc-translation-trigger'?{focus}:undefined};
  const cleanups=hooks.effects.map(effect=>effect());
  const escape=documentListeners.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
  const input={key:'Escape',defaultPrevented:false,isComposing:false,keyCode:27,preventDefault:vi.fn(),stopPropagation:vi.fn()};
  escape(input as unknown as KeyboardEvent);
  expect(input.preventDefault).toHaveBeenCalledOnce();expect(input.stopPropagation).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledOnce();
  expect(nodes(render(props)).some(node=>node.type==='aside')).toBe(false);
  for(const cleanup of cleanups)cleanup?.();
 });
 it.each(['menu','listbox','dialog'])('lets an open nested %s popover handle Escape before reader settings',role=>{
  const documentListeners=vi.fn(),windowListeners=vi.fn();let open=true;
  const querySelector=vi.fn((selector:string)=>open&&selector.includes(':popover-open')&&selector.includes(`role="${role}"`)?{}:null);
  vi.stubGlobal('document',{querySelector,addEventListener:documentListeners,removeEventListener:vi.fn()});
  vi.stubGlobal('window',{addEventListener:windowListeners,removeEventListener:vi.fn()});
  const props=fixture();render(props);hooks.handlers['reader.translationSettings']();render(props);
  const cleanups=hooks.effects.map(effect=>effect());
  const capture=documentListeners.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
  const bubble=windowListeners.mock.calls.find(([type])=>type==='keydown')![1] as (event:KeyboardEvent)=>void;
  const input={key:'Escape',defaultPrevented:false,isComposing:false,keyCode:27,preventDefault:vi.fn(),stopPropagation:vi.fn()};
  capture(input as unknown as KeyboardEvent);bubble(input as unknown as KeyboardEvent);
  expect(input.preventDefault).not.toHaveBeenCalled();expect(input.stopPropagation).not.toHaveBeenCalled();
  expect(nodes(render(props)).some(node=>node.type==='aside'&&node.props['aria-label']==='翻译选项')).toBe(true);
  // Once the nested control closes, the next Escape retains the original reader dismissal.
  open=false;capture(input as unknown as KeyboardEvent);
  expect(input.preventDefault).toHaveBeenCalledOnce();expect(input.stopPropagation).toHaveBeenCalledOnce();
  expect(nodes(render(props)).some(node=>node.type==='aside')).toBe(false);
  for(const cleanup of cleanups)cleanup?.();
 });
});
