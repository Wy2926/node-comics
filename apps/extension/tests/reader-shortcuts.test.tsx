import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
import type {ReadingEntry} from '../src/types';
import type {ReadingView} from '../src/reader/view';

// Exercise the actual reader command callbacks without images, browser layout, or a translation service.
const hooks=vi.hoisted(()=>({cursor:0,states:[] as unknown[],layoutEffects:[] as (()=>void|(()=>void))[],effects:[] as (()=>void|(()=>void))[],handlers:{} as Record<string,()=>void|boolean>,enabled:true,stream:undefined as ReadingEntry[]|undefined,index:2,previous:undefined as ReadingEntry|undefined}));
const actions=vi.hoisted(()=>({preserve:vi.fn(),persist:vi.fn(),restore:vi.fn(),jump:vi.fn(),requestTranslation:vi.fn(),track:vi.fn()}));
const spreadZoom=vi.hoisted(()=>({zoom:100,zoomed:false,change:vi.fn(),reset:vi.fn()}));
const swipe=vi.hoisted(()=>({options:undefined as Parameters<typeof import('../src/reader/usePagedSwipe').usePagedSwipe>[0]|undefined}));
vi.mock('../src/reader/usePagedSwipe',async original=>{
 const {usePagedSwipe}=await original<typeof import('../src/reader/usePagedSwipe')>();
 return {usePagedSwipe:(options:NonNullable<typeof swipe.options>)=>{swipe.options=options;return usePagedSwipe(options);}};
});
vi.mock('../src/reader/useSpreadZoom',()=>({useSpreadZoom:()=>spreadZoom}));
vi.mock('react',async original=>({
 ...await original<typeof import('react')>(),
 useState:<T,>(initial?:T|(()=>T))=>{
  const index=hooks.cursor++;
  if(!(index in hooks.states))hooks.states[index]=typeof initial==='function'?(initial as ()=>T)():initial;
  return [hooks.states[index],(next:T|((value:T)=>T))=>{hooks.states[index]=typeof next==='function'?(next as (value:T)=>T)(hooks.states[index] as T):next;}];
 },
 useRef:(current:unknown)=>({current}),useMemo:(compute:()=>unknown)=>compute(),
 useEffect:(effect:()=>void|(()=>void))=>{hooks.effects.push(effect);},
 useLayoutEffect:(effect:()=>void|(()=>void))=>{hooks.layoutEffects.push(effect);},
}));
vi.mock('../src/shortcuts/react',()=>({useShortcuts:(handlers:typeof hooks.handlers,options:{enabled:boolean})=>{hooks.handlers=handlers;hooks.enabled=options.enabled;}}));
vi.mock('../src/reader/useReaderAnalytics',()=>({useReaderAnalytics:()=>({requestTranslation:actions.requestTranslation})}));
vi.mock('../src/analytics',()=>({track:actions.track}));
vi.mock('../src/reader/useChapterStream',()=>({
 pageKey:(copy:ReadingEntry,pageId:string)=>`${copy.id}:${pageId}`,completeManifest:()=>true,
 useChapterStream:({copy}:{copy:ReadingEntry})=>({
  index:hooks.index,indexRef:{current:hooks.index},anchor:{current:{entryId:copy.id,pageId:copy.pages[hooks.index]?.id??copy.pageId,relativeOffset:copy.relativeOffset}},processingAhead:4,viewport:{current:null},cells:{current:new Map()},ends:{current:new Map()},stacks:{current:new Map()},geometry:{current:new Map()},
  stream:hooks.stream??[copy],previous:hooks.previous,next:hooks.stream?.[1],nextOf:()=>undefined,...actions,scroll:()=>{},navigationReason:{current:'direct'},pageShown:()=>{},resources:{ready:()=>true},resourceVersion:0,
 }),
}));
import {Reader} from '../src/reader/Reader';
import {ReaderShell, ReaderDrawer, ReaderNavigation, ReaderSettingsButton, ReaderTools} from '../src/reader/ReaderChrome';
import {ReaderSettings, ReaderScale, ReaderChoice, ReaderTranslationSettings} from '../src/reader/ReaderSettings';
import {ReaderDisplaySettings} from '../src/reader/ReaderOptions';
import {ComicDirectory} from '../src/reader/ComicDirectory';
import {ThumbnailDirectory} from '../src/reader/ThumbnailDirectory';
import {defaults} from '../src/types';
import {installDictionary} from '../src/i18n/runtime';

type Props=Parameters<typeof Reader>[0];
const copy:ReadingEntry={id:'reader-fixture',title:'Fixture',source:'zip',sourceKey:'fixture',generation:1,createdAt:0,updatedAt:0,pageId:'page-2',relativeOffset:.35,discoveryComplete:true,
 pages:Array.from({length:5},(_,index)=>({id:`page-${index}`,name:`Page ${index+1}`,width:1000,height:1500,imageSha256:`source-image-${index}`,jobs:[],outputBlobs:{}}))};
function fixture(extra:Partial<Props>={}){
 const props:Props={
  viewKey:'fixture',copy,sequence:[copy],settings:{...defaults},setSettings:vi.fn(),update:vi.fn(),onBack:vi.fn(),onOpenShortcuts:vi.fn(),onRetry:vi.fn(),onFind:vi.fn(),
  onUpgrade:vi.fn(),onLogin:vi.fn(),onImport:vi.fn(),notify:vi.fn(),onMarkRead:vi.fn(async()=>{}),onNavigate:vi.fn(),onActiveEntry:vi.fn(),onLoadEntry:vi.fn(),
  onReadingWindow:vi.fn(),translationState:vi.fn(),busy:false,...extra,
 };
 props.setSettings=vi.fn(next=>{props.settings=typeof next==='function'?next(props.settings):next;});
 return props;
}
function render(props:Props){hooks.cursor=0;hooks.layoutEffects=[];hooks.effects=[];return Reader(props);}
function flushLayoutEffects(){for(const effect of hooks.layoutEffects.splice(0))effect();}
function flushEffects(){flushLayoutEffects();for(const effect of hooks.effects.splice(0))effect();}
function view(){return hooks.states.find((value):value is ReadingView=>!!value&&typeof value==='object'&&'zoom' in value)!;}
function nodes(node:unknown):ReactElement<Record<string,unknown>>[]{
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!node||typeof node!=='object'||!('props' in node))return [];
 const element=node as ReactElement<Record<string,unknown>>;
 if([ReaderShell,ReaderDrawer,ReaderNavigation,ReaderSettingsButton,ReaderTools,ReaderSettings,ReaderDisplaySettings,ReaderScale,ReaderChoice,ReaderTranslationSettings].includes(element.type as never))return [element,...nodes((element.type as (props:Record<string,unknown>)=>unknown)(element.props))];
 return [element,...nodes(element.props.children)];
}
function click(tree:ReactElement,match:(node:ReactElement<Record<string,unknown>>)=>boolean){
 const node=nodes(tree).find(match);expect(node).toBeDefined();(node!.props.onClick as ()=>void)();
}
beforeEach(()=>{
 hooks.states=[];hooks.cursor=0;hooks.handlers={};hooks.enabled=true;hooks.stream=undefined;hooks.index=2;hooks.previous=undefined;
 for(const action of Object.values(actions))action.mockClear();
 spreadZoom.change.mockClear();spreadZoom.reset.mockClear();
 installDictionary('zh-CN',{});
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:vi.fn()});
 vi.stubGlobal('document',{querySelector:()=>null,addEventListener:vi.fn(),removeEventListener:vi.fn()});
 vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
});
afterEach(()=>vi.unstubAllGlobals());

describe('reader shortcut action integration',()=>{
 it.each(['single','double'] as const)('preserves the %s animation viewport and reset scope through an empty chapter and loaded content',layout=>{
  const props=fixture({settings:{...defaults,layout}}),before=render(props),resetKey=swipe.options!.resetKey,identity=swipe.options!.identity;
  props.copy={...copy,id:'chapter-two',contentId:'chapter-two-content',generation:2,pages:[]};
  const loading=render(props);
  expect(swipe.options).toMatchObject({enabled:true,resetKey});expect(swipe.options!.identity).not.toBe(identity);
  expect(swipe.options!.canTurn(1)).toBe(false);
  const viewportSlot=(tree:ReturnType<typeof Reader>)=>(tree.props.children as ReactElement<{className?:string}>[]).findIndex(child=>child?.props?.className==='nc-reading-viewport');
  expect(viewportSlot(before)).toBeGreaterThanOrEqual(0);expect(viewportSlot(loading)).toBe(viewportSlot(before));
  for(const tree of [before,loading]){
   expect(nodes(tree).filter(node=>node.props.className==='nc-reading-surface')).toHaveLength(1);
  }
  props.copy={...props.copy,pages:copy.pages};render(props);
  expect(swipe.options).toMatchObject({enabled:true,resetKey});
  hooks.handlers['reader.layout']();render(props);expect(swipe.options!.resetKey).not.toBe(resetKey);
 });
 it.each(['single','double'] as const)('enables the first-page previous control only with a preceding chapter in %s',layout=>{
  hooks.index=0;const props=fixture({settings:{...defaults,layout}});
  const previous=(tree:ReactElement)=>nodes(tree).find(node=>node.props['aria-label']==='上一页')!;
  expect(previous(render(props)).props.disabled).toBe(true);
  hooks.previous={...copy,id:'previous'};
  expect(previous(render(props)).props.disabled).toBe(false);
  hooks.handlers['reader.previous']();expect(actions.jump).toHaveBeenLastCalledWith(-1);
 });
 it.each(['contentId','generation'] as const)('changes both comparison pixel scopes when %s changes without changing page IDs',field=>{
  const props=fixture({settings:{...defaults,layout:'single'}});render(props);hooks.handlers['reader.compare']();
  const scopes=()=>nodes(render(props)).filter(node=>typeof node.props.scope==='string').map(node=>node.props.scope);
  const before=scopes();expect(before).toHaveLength(2);
  props.copy={...props.copy,...(field==='contentId'?{contentId:'replacement-content'}:{generation:props.copy.generation+1})};
  const after=scopes();expect(after).toHaveLength(2);
  expect(after.every((scope,n)=>scope!==before[n])).toBe(true);
 });
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
  expect(view()).toEqual({mode:'classic',preference:'original',zoom:200,fit:'width'});
  for(let index=0;index<25;index++)hooks.handlers['reader.zoomOut']();
  expect(view().zoom).toBe(40);hooks.handlers['reader.zoomReset']();expect(view().zoom).toBe(100);
  expect(actions.preserve).toHaveBeenCalledTimes(41);
 });
 it('changes layout and fit through the same preserving controls while retaining unrelated settings',()=>{
  const props=fixture();render(props);hooks.handlers['reader.layout']();hooks.handlers['reader.fit']();
  expect(props.settings).toEqual(defaults);expect(view()).toMatchObject({layout:'single',fit:'window'});
  expect(actions.preserve).toHaveBeenCalledTimes(2);
  render(props);hooks.handlers['reader.layout']();expect(view().layout).toBe('double');expect(view().direction).toBeUndefined();
  render(props);expect(hooks.handlers['reader.fit']()).toBe(false);expect(view().fit).toBe('window');
  hooks.handlers['reader.layout']();expect(view().layout).toBe('continuous');expect(view().direction).toBeUndefined();
  render(props);hooks.handlers['reader.fit']();expect(view().fit).toBe('width');
  expect(props.setSettings).not.toHaveBeenCalled();expect(props.settings).toEqual(defaults);
 });
 it('inherits later global defaults without pinning a layout when only opening or zooming a comic',()=>{
  const props=fixture(),layout=(tree:ReactElement)=>nodes(tree).find(node=>node.props.className==='nc-reading-viewport')?.props['data-layout'];
  expect(layout(render(props))).toBe('continuous');flushEffects();expect(view()).not.toHaveProperty('layout');
  hooks.handlers['reader.zoomIn']();props.settings={...props.settings,layout:'single'};
  expect(layout(render(props))).toBe('single');flushEffects();expect(view()).not.toHaveProperty('layout');
  props.settings={...props.settings,layout:'double'};expect(layout(render(props))).toBe('double');
  expect(props.setSettings).not.toHaveBeenCalled();
 });
 it('remembers each comic across chapters and reopening without changing the global defaults',()=>{
  const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value)});
  const a=fixture({viewKey:'comic-a'});render(a);hooks.handlers['reader.layout']();render(a);hooks.handlers['reader.layout']();render(a);flushEffects();
  const chosen={...view()};expect(chosen.layout).toBe('double');expect(chosen.direction).toBeUndefined();
  a.copy={...a.copy,id:'chapter-two'};render(a);expect(view()).toEqual(chosen);
  hooks.states=[];const b=fixture({viewKey:'comic-b',settings:{...defaults,layout:'single'}});render(b);flushEffects();
  expect(view().layout).toBeUndefined();expect(view().direction).toBeUndefined();
  hooks.handlers['reader.layout']();render(b);hooks.handlers['reader.layout']();render(b);flushEffects();expect(view().layout).toBe('continuous');
  hooks.states=[];a.settings={...defaults,layout:'single'};const reopened=render(a);
  expect(view()).toEqual(chosen);expect(nodes(reopened).find(node=>node.props.className==='nc-reading-viewport')?.props['data-layout']).toBe('double');
  expect(a.setSettings).not.toHaveBeenCalled();expect(b.setSettings).not.toHaveBeenCalled();
 });
 it('treats an explicit same-as-default choice as an override and can return to following defaults',()=>{
  const props=fixture();render(props);hooks.handlers['reader.settings']();
  const options=()=>nodes(render(props)).find(node=>node.type===ReaderSettings)!.props as unknown as Parameters<typeof ReaderSettings>[0];
  options().onLayout('continuous');expect(view().layout).toBe('continuous');
  props.settings={...props.settings,layout:'single'};expect(options().layout).toBe('continuous');
  options().onDirection('rtl');expect(view().direction).toBe('rtl');
  options().onLayout(undefined);expect(view().layout).toBeUndefined();expect(view().direction).toBe('rtl');
  expect(nodes(render(props)).find(node=>node.props.className==='nc-reading-viewport')?.props['data-layout']).toBe('single');
  expect(props.setSettings).not.toHaveBeenCalled();
 });
 it.each(['ltr','rtl'] as const)('never changes the explicit comic direction when selecting or cycling layouts (%s)',direction=>{
  const props=fixture();render(props);hooks.handlers['reader.settings']();
  const options=()=>nodes(render(props)).find(node=>node.type===ReaderSettings)!.props as unknown as Parameters<typeof ReaderSettings>[0];
  options().onDirection(direction);
  for(const layout of ['double','single','continuous','double',undefined] as const){
   options().onLayout(layout);expect(view().layout).toBe(layout);expect(view().direction).toBe(direction);
  }
  for(let i=0;i<3;i++){render(props);hooks.handlers['reader.layout']();expect(view().direction).toBe(direction);}
  expect(props.setSettings).not.toHaveBeenCalled();expect(props.settings).toEqual(defaults);
 });
 it('persists the immersive shortcut in shared preferences without changing the comic view',()=>{
  const props=fixture();render(props);const before={...view()};
  hooks.handlers['reader.immersive']();expect(props.settings.readerImmersive).toBe(false);
  const tree=render(props);expect(tree.props.immersive).toBe(false);expect(view()).toEqual(before);
  hooks.states=[];expect(render(props).props.immersive).toBe(false);
  hooks.handlers['reader.immersive']();expect(props.settings).toEqual(defaults);
 });
 it('keeps a comic layout selected before phone dimensions arrive',()=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture({copy:{...copy,pages:copy.pages.map(page=>({...page,imageSha256:undefined}))}});render(props);
  hooks.handlers['reader.layout']();expect(view().layout).toBe('single');
  props.copy={...props.copy,pages:props.copy.pages.map(page=>({...page,height:6000,imageSha256:`real-${page.id}`}))};
  render(props);flushEffects();expect(view().layout).toBe('single');expect(props.setSettings).not.toHaveBeenCalled();
 });
 it('allows local layout changes when preference storage cannot be read or written',()=>{
  vi.stubGlobal('localStorage',{getItem:()=>{throw Error('Unavailable');},setItem:()=>{throw Error('Full');}});
  const props=fixture();render(props);hooks.handlers['reader.layout']();
  expect(()=>{render(props);flushEffects();}).not.toThrow();expect(view().layout).toBe('single');expect(props.setSettings).not.toHaveBeenCalled();
 });
 it.each(['ltr','rtl'] as const)('turns whole spreads from either selected page while honoring direction (%s)',direction=>{
  render(fixture({settings:{...defaults,layout:'double',direction}}));
  hooks.handlers['reader.left']();hooks.handlers['reader.right']();hooks.handlers['reader.previous']();hooks.handlers['reader.next']();
  expect(actions.jump.mock.calls.map(([page])=>page)).toEqual(direction==='rtl'?[3,0,0,3]:[0,3,0,3]);
 });
 it('fits both pages without changing the saved fit and zoom, including when shortcuts are pressed',()=>{
  const props=fixture({settings:{...defaults,layout:'double'}}),tree=render(props);
  const pages=nodes(tree).filter(node=>node.props.className==='nc-manga-page');
  expect(pages.map(page=>page.props['data-page-index'])).toEqual([1,2]);
  expect(pages.reduce((width,page)=>width+(page.props.style as {width:number}).width,0)).toBe(900);
  const saved={...view()};
  expect(hooks.handlers['reader.fit']()).toBe(false);
  for(const action of ['reader.zoomIn','reader.zoomOut','reader.zoomReset'])hooks.handlers[action]();
  expect(spreadZoom.change.mock.calls.map(([value])=>typeof value==='function'?value(100):value)).toEqual([110,90,100]);
  expect(view()).toEqual(saved);expect(actions.preserve).not.toHaveBeenCalled();
  hooks.handlers['reader.settings']();
  const controls=nodes(render(props));
  expect(controls.some(node=>node.type===ReaderChoice&&node.props.label==='图片适应方式')).toBe(false);
  expect(controls.find(node=>node.type===ReaderScale)?.props).toMatchObject({value:100,min:100,max:400});
 });
 it('starts translation lookahead at the first displayed page after jumping to the second page of a spread',()=>{
  const props=fixture({settings:{...defaults,layout:'double'}});render(props);hooks.handlers['reader.translation']();render(props);flushEffects();
  const [targets,visible]=vi.mocked(props.onReadingWindow).mock.calls.at(-1)!;
  expect(targets.map(target=>target.page.id)).toEqual(['page-1','page-2','page-3','page-4']);
  expect(visible.map(page=>page.id)).toEqual(['page-1','page-2']);
 });
 it.each(['single','double','continuous'] as const)('translates five extra pages beyond the current reading page or spread in %s',layout=>{
  const chapter={...copy,pages:Array.from({length:12},(_,index)=>({...copy.pages[0],id:`page-${index}`}))};
  const props=fixture({copy:chapter,sequence:[chapter],settings:{...defaults,layout}});
  render(props);hooks.handlers['reader.translation']();render(props);flushEffects();
  const [targets,visible]=vi.mocked(props.onReadingWindow).mock.calls.at(-1)!;
  expect(targets.map(target=>target.page.id)).toEqual(Array.from({length:layout==='double'?7:6},(_,n)=>`page-${n+(layout==='double'?1:2)}`));
  expect(visible).toHaveLength(layout==='double'?2:layout==='single'?1:4);
 });
 it.each([0,3])('uses one current target plus five successors for a double-layout cover or landscape at index %i',index=>{
  hooks.index=index;
  const chapter={...copy,pages:Array.from({length:12},(_,n)=>({...copy.pages[0],id:`page-${n}`,...(n===3?{width:1600,height:1000}:{} )}))};
  const props=fixture({copy:chapter,sequence:[chapter],settings:{...defaults,layout:'double'}});
  render(props);hooks.handlers['reader.translation']();render(props);flushEffects();
  const [targets,visible]=vi.mocked(props.onReadingWindow).mock.calls.at(-1)!;
  expect(targets.map(target=>target.page.id)).toEqual(Array.from({length:6},(_,n)=>`page-${index+n}`));expect(visible).toHaveLength(1);
 });
 it('does not translate the next ready chapter while the current ready chapter is empty',()=>{
  const empty={...copy,pages:[]},next={...copy,id:'next-chapter',pages:copy.pages.map(page=>({...page,id:`next-${page.id}`}))};
  hooks.stream=[empty,next];
  vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',fit:'width',zoom:100}),setItem:vi.fn()});
  const props=fixture({copy:empty,sequence:hooks.stream});render(props);flushEffects();
  expect(view().preference).toBe('translation');
  expect(vi.mocked(props.onReadingWindow).mock.calls.at(-1)![0]).toEqual([]);
 });
 it.each(['continuous','single','double'] as const)('fills five successors from the next ready chapter without mounting them in %s',layout=>{
  const next={...copy,id:'next-chapter',pages:Array.from({length:20},(_,index)=>({...copy.pages[0],id:`next-${index}`}))};
  hooks.stream=[copy,next];
  vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',fit:'width',zoom:100}),setItem:vi.fn()});
  const props=fixture({sequence:hooks.stream,settings:{...defaults,layout}});render(props);flushEffects();
  const [targets,visible]=vi.mocked(props.onReadingWindow).mock.calls.at(-1)!;
  expect(targets.map(target=>target.page.id)).toEqual([...(layout==='double'?['page-1']:[]),'page-2','page-3','page-4','next-0','next-1','next-2']);
  expect(targets.slice(-3).every(target=>target.entryId===next.id)).toBe(true);
  expect(visible.map(page=>page.id)).toEqual(layout==='continuous'?['page-2','page-3','page-4','next-0']:layout==='double'?['page-1','page-2']:['page-2']);
 });
 it.each(['single','double'] as const)('does not render footer content in %s mode and disables next when its last spread is shown',layout=>{
  const props=fixture({settings:{...defaults,layout},copy:{...copy,pages:copy.pages.slice(0,3)}}),tree=render(props);
  const end=nodes(tree).find(node=>node.props['data-paged']===true)!;
  expect(nodes(end.props.children)).toEqual([]);
  expect(nodes(tree).find(node=>node.props['aria-label']==='下一页')?.props.disabled).toBe(true);
 });
 it.each(['continuous','single','double'] as const)('does not add an invisible gutter to the full-width %s canvas or its swipe decision',layout=>{
  vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'original',zoom:100,fit:'width'}),setItem:vi.fn()});
  const elements=nodes(render(fixture({settings:{...defaults,layout}})));
  for(const className of ['nc-reading-clip','nc-reading-surface']){
   expect(elements.find(node=>node.props.className===className)?.props.style).toEqual({minWidth:900});
  }
  expect(elements.find(node=>node.props.className==='nc-reading-viewport')?.props['data-swipe-enabled']).toBe(layout!=='continuous');
 });
 it('defaults desktop sizing to width at 50 percent independently of global settings and restores the comic fit',()=>{
  const props=fixture({settings:{...defaults,fit:'width'}});const initial=render(props);
  expect(view()).toEqual({mode:'classic',preference:'original',zoom:50,fit:'width'});
  const pageWidth=(tree:ReactElement)=>nodes(tree).find(node=>node.props.className==='nc-manga-page')!.props.style as {width:number};
  expect(pageWidth(initial).width).toBe(450);
  hooks.handlers['reader.fit']();const fitted=render(props);expect(pageWidth(fitted).width).toBeCloseTo(700/3);
  expect(props.setSettings).not.toHaveBeenCalled();expect(props.settings.fit).toBe('width');
  hooks.handlers['reader.settings']();const settings=render(props);
  const choice=nodes(settings).find(node=>node.type===ReaderChoice&&node.props.label==='图片适应方式')!;
  expect(choice.props.value).toBe('window');(choice.props.onChange as (value:string)=>void)('width');
  expect(view().fit).toBe('width');expect(props.setSettings).not.toHaveBeenCalled();expect(actions.preserve).toHaveBeenCalledTimes(2);
  hooks.states=[];vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom:100,fit:'width'}),setItem:vi.fn()});
  const restored=render(props);expect(view()).toEqual({mode:'classic',preference:'translation',zoom:100,fit:'width'});expect(pageWidth(restored).width).toBe(900);
 });
 it('restores the saved phone long-image view when reopening an ordinary chapter',()=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const stored=new Map<string,string>(),setItem=vi.fn((key:string,value:string)=>stored.set(key,value));
  vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem});
  const long=fixture({copy:{...copy,pages:copy.pages.map(page=>({...page,height:6000}))}});
  const tree=render(long);expect(view()).toEqual({mode:'classic',preference:'original',fit:'width',zoom:100});
  expect((nodes(tree).find(node=>node.props.className==='nc-manga-page')!.props.style as {width:number}).width).toBe(900);
  flushEffects();expect(JSON.parse(stored.get('fixture')!)).toEqual(view());
  const ordinary=fixture({copy:{...copy,id:'ordinary-chapter'}});
  hooks.states=[];render(ordinary);expect(view()).toEqual({mode:'classic',preference:'original',fit:'width',zoom:100});
  hooks.states=[];render({...ordinary,viewKey:'unsaved-ordinary'});expect(view()).toEqual({mode:'classic',preference:'original',fit:'window',zoom:100});
  expect(long.setSettings).not.toHaveBeenCalled();
 });
 it('applies desktop sizing before placeholder dimensions resolve without a later sizing jump',()=>{
  const setItem=vi.fn();vi.stubGlobal('localStorage',{getItem:()=>null,setItem});
  const props=fixture({copy:{...copy,pages:[]}});render(props);flushEffects();
  expect(view()).toEqual({mode:'classic',preference:'original',fit:'width',zoom:50});
  expect(setItem).toHaveBeenCalledWith('fixture',JSON.stringify(view()));
  props.copy={...copy,pages:copy.pages.map(page=>({...page,width:900,height:1300,imageSha256:undefined}))};
  render(props);flushEffects();expect(view()).toEqual({mode:'classic',preference:'original',fit:'width',zoom:50});
  props.copy={...props.copy,pages:props.copy.pages.map(page=>({...page,width:800,height:24000,imageSha256:`real-${page.id}`}))};
  render(props);flushEffects();expect(view()).toEqual({mode:'classic',preference:'original',fit:'width',zoom:50});
  expect(actions.preserve).not.toHaveBeenCalled();
 });
 it.each([
  {compact:false,touch:false},
  {compact:true,touch:false},
  {compact:false,touch:true},
  {compact:true,touch:true},
 ])('uses 100 percent for phones and tablets without changing their initial fit: %j',({compact,touch})=>{
  vi.stubGlobal('window',{matchMedia:(query:string)=>({matches:query==='(pointer: coarse), (hover: none)'||query.includes('max-device-width')?touch:compact}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  render(fixture());expect(view()).toEqual({mode:'classic',preference:'original',fit:compact&&touch?'window':'width',zoom:touch?100:50});
 });
 it('saves the opening zoom and fits a newly identified long phone page before passive effects',()=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const stored=new Map<string,string>();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value)});
  const props=fixture({settings:{...defaults,readerZoom:130},copy:{...copy,pages:[]}});render(props);flushEffects();
  const opening={mode:'classic',preference:'original',fit:'window',zoom:130};
  expect(JSON.parse(stored.get('fixture')!)).toEqual(opening);
  props.settings={...props.settings,readerZoom:70};
  props.copy={...copy,pages:copy.pages.map(page=>({...page,width:900,height:1300,imageSha256:undefined}))};
  render(props);flushEffects();expect(JSON.parse(stored.get('fixture')!)).toEqual(opening);
  props.copy={...props.copy,pages:props.copy.pages.map(page=>({...page,width:800,height:24000,imageSha256:`real-${page.id}`}))};
  render(props);flushLayoutEffects();expect(view()).toEqual({...opening,fit:'width'});
  expect(actions.preserve).toHaveBeenCalledOnce();
  const fitted=render(props);
  expect((nodes(fitted).find(node=>node.props.className==='nc-manga-page')!.props.style as {width:number}).width).toBe(900*1.3);
  flushEffects();expect(JSON.parse(stored.get('fixture')!)).toEqual({...opening,fit:'width'});
 });
 it.each([false,true])('keeps the opening zoom across global changes, chapters and reopening; only another unread comic uses the new value (touch: %s)',touch=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:touch}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value)});
  const props=fixture({settings:{...defaults,readerZoom:130}});render(props);flushEffects();
  expect(view().zoom).toBe(130);
  props.settings={...props.settings,readerZoom:70};render(props);flushEffects();expect(view().zoom).toBe(130);
  props.copy={...copy,id:'next-chapter'};render(props);flushEffects();expect(view().zoom).toBe(130);
  hooks.states=[];render(props);expect(view().zoom).toBe(130);
  hooks.states=[];render({...props,viewKey:'unread-comic'});expect(view().zoom).toBe(70);
  expect(props.setSettings).not.toHaveBeenCalled();
 });
 it('keeps the first zoom on reopening even if image loading never succeeded',()=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>stored.set(key,value)});
  const props=fixture({settings:{...defaults,readerZoom:120},copy:{...copy,pages:[]}});render(props);flushEffects();
  hooks.states=[];render({...props,settings:{...props.settings,readerZoom:60}});
  expect(view()).toEqual({mode:'classic',preference:'original',fit:'window',zoom:120});
 });
 it.each(['fit','zoomIn'] as const)('preserves a manual %s change made before the actual long-image dimensions arrive',command=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture({copy:{...copy,pages:copy.pages.map(page=>({...page,imageSha256:undefined}))}});
  render(props);flushEffects();
  // Keep the selected view distinct from the pending long-image width/100 preset.
  if(command==='fit'){hooks.handlers['reader.fit']();render(props);}
  hooks.handlers[`reader.${command}`]();
  const selected={...view()};
  expect(selected).toEqual({mode:'classic',preference:'original',fit:'window',zoom:command==='fit'?100:110});
  props.copy={...props.copy,pages:props.copy.pages.map(page=>({...page,height:6000,imageSha256:`real-${page.id}`}))};
  render(props);flushEffects();expect(view()).toEqual(selected);
  expect(props.setSettings).not.toHaveBeenCalled();
 });
 it('preserves a manual choice even when a queued initialization effect sees the newly loaded dimensions',()=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:true}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture({copy:{...copy,pages:copy.pages.map(page=>({...page,imageSha256:undefined}))}});render(props);
  props.copy={...props.copy,pages:props.copy.pages.map(page=>({...page,height:6000,imageSha256:`real-${page.id}`}))};
  render(props);hooks.handlers['reader.zoomIn']();const selected={...view()};
  expect(selected).toEqual({mode:'classic',preference:'original',fit:'window',zoom:110});
  flushEffects();expect(view()).toEqual(selected);
 });
 it.each([undefined,140])('keeps an existing legacy view with zoom %s independently of the new global default',zoom=>{
  vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({mode:'classic',preference:'translation',zoom}),setItem:vi.fn()});
  const props=fixture({settings:{...defaults,readerZoom:70},copy:{...copy,pages:copy.pages.map(page=>({...page,height:6000}))}});
  render(props);flushEffects();expect(view()).toEqual({mode:'classic',preference:'translation',fit:'window',zoom:zoom??100});
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
 it.each([true,false])('dismisses selected phone chapters/pages without changing the desktop directory (%s)',compact=>{
  vi.stubGlobal('window',{matchMedia:()=>({matches:compact}),addEventListener:vi.fn(),removeEventListener:vi.fn()});
  const props=fixture();render(props);hooks.handlers['reader.directory']();
  const directory=nodes(render(props)).find(node=>node.type===ComicDirectory)!;
  (directory.props.onNavigate as (id:string)=>void)('chapter-2');
  expect(props.onNavigate).toHaveBeenCalledWith('chapter-2',undefined,undefined);
  expect(actions.preserve).toHaveBeenCalledOnce();expect(actions.persist).toHaveBeenCalledOnce();
  expect(nodes(render(props)).some(node=>node.type==='aside')).toBe(!compact);
  if(compact)hooks.handlers['reader.directory']();
  const thumbnails=nodes(render(props)).find(node=>node.type===ThumbnailDirectory)!;
  (thumbnails.props.onJump as (index:number)=>void)(3);
  expect(actions.jump).toHaveBeenCalledWith(3);
  expect(nodes(render(props)).some(node=>node.type==='aside')).toBe(!compact);
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
 it.each(['menu','listbox','dialog'].flatMap(role=>[true,false].map(native=>({role,native}))))('lets an open nested $role popover handle Escape before reader settings (native: $native)',({role,native})=>{
  const documentListeners=vi.fn(),windowListeners=vi.fn();let open=true;
  const querySelector=vi.fn((selector:string)=>open&&selector.includes(native?':popover-open':'[data-popover-fallback-open]')&&selector.includes(`role="${role}"`)?{}:null);
  vi.stubGlobal('document',{defaultView:{HTMLElement:{prototype:native?{showPopover:()=>{}}:{}}},querySelector,addEventListener:documentListeners,removeEventListener:vi.fn()});
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
