import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const hooks=vi.hoisted(()=>({state:0,ref:0,effect:0,dirty:false,states:[] as unknown[],refs:[] as {current:unknown}[],effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:<T,>(initial?:T)=>{const n=hooks.state++;if(!(n in hooks.states))hooks.states[n]=initial;return [hooks.states[n],(value:T)=>{if(!Object.is(value,hooks.states[n]))hooks.dirty=true;hooks.states[n]=value;}];},
  useRef:(initial:unknown)=>hooks.refs[hooks.ref++]??={current:initial},
  useEffect:(callback:()=>void|(()=>void),deps:unknown[])=>{const n=hooks.effect++,previous=hooks.effects[n];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))hooks.pending.push(()=>{previous?.cleanup?.();hooks.effects[n]={deps,cleanup:callback()||undefined};});},
}));
vi.mock('../src/comics/application/image-access',()=>({readThumbnail:vi.fn(),acquireImage:vi.fn(),promoteImage:vi.fn()}));
import {Thumbnail} from '../src/reader/Images';
import {readThumbnail} from '../src/comics/application/image-access';

let intersection:(entries:{isIntersecting:boolean}[])=>void;
let props:Parameters<typeof Thumbnail>[0],tree:ReturnType<typeof Thumbnail>;
const disconnect=vi.fn();
function draw(){
  do{
    hooks.state=hooks.ref=hooks.effect=0;hooks.dirty=false;
    tree=Thumbnail(props);tree.props.ref.current={} as HTMLSpanElement;
    while(hooks.pending.length)hooks.pending.shift()!();
  }while(hooks.dirty);
}
function visible(value:boolean){intersection([{isIntersecting:value}]);draw();}
beforeEach(()=>{
  hooks.states=[];hooks.refs=[];hooks.effects=[];hooks.pending=[];disconnect.mockClear();
  vi.stubGlobal('IntersectionObserver',class {constructor(callback:typeof intersection){intersection=callback;}observe(){}disconnect=disconnect;});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:thumbnail');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.mocked(readThumbnail).mockReset().mockResolvedValue(new Blob(['thumbnail']));
  props={blobKey:'page:first'};
});
afterEach(()=>{for(const effect of hooks.effects)effect.cleanup?.();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('visible thumbnail resource lifecycle',()=>{
  it('defers a bookmark lookup until visible, reuses stable inputs and releases its URL on leaving the viewport',async()=>{
    const resolveKey=vi.fn(async(_signal:AbortSignal)=> 'page:first');props={resolveKey};draw();
    expect(resolveKey).not.toHaveBeenCalled();expect(readThumbnail).not.toHaveBeenCalled();
    visible(true);await vi.waitFor(()=>expect(URL.createObjectURL).toHaveBeenCalledOnce());draw();
    expect(tree.props.children.type).toBe('img');draw();expect(readThumbnail).toHaveBeenCalledOnce();
    const signal=resolveKey.mock.calls[0][0] as AbortSignal;
    visible(false);expect(signal.aborted).toBe(true);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail');expect(tree.props.children.type).not.toBe('img');
  });
  it('does not start an image read when an offscreen bookmark lookup finishes late',async()=>{
    const pending=Promise.withResolvers<string>();props={resolveKey:()=>pending.promise};draw();visible(true);visible(false);
    pending.resolve('page:late');await pending.promise;await Promise.resolve();draw();
    expect(readThumbnail).not.toHaveBeenCalled();expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('cancels a pending read on unmount and does not allocate an orphaned URL',async()=>{
    const pending=Promise.withResolvers<Blob>();vi.mocked(readThumbnail).mockReturnValue(pending.promise);draw();visible(true);
    const signal=vi.mocked(readThumbnail).mock.calls[0][1]!;
    for(const effect of hooks.effects)effect.cleanup?.();hooks.effects=[];
    expect(signal.aborted).toBe(true);expect(disconnect).toHaveBeenCalledOnce();
    pending.resolve(new Blob(['late']));await pending.promise;await Promise.resolve();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('keeps the placeholder usable when a thumbnail fails or an old bookmark no longer resolves',async()=>{
    const onError=vi.fn();props={blobKey:'page:unavailable',onError};vi.mocked(readThumbnail).mockRejectedValue(Error('unavailable'));draw();visible(true);
    await vi.waitFor(()=>expect(onError).toHaveBeenCalledOnce());draw();expect(tree.props.children.type).not.toBe('img');
    props={resolveKey:async()=>undefined,onError};draw();await Promise.resolve();draw();
    expect(readThumbnail).toHaveBeenCalledOnce();expect(onError).toHaveBeenCalledOnce();expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
