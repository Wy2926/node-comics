import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';

const hooks = vi.hoisted(() => ({state: 0, ref: 0, effect: 0, dirty: false,
  states: [] as unknown[], refs: [] as {current: unknown}[],
  effects: [] as {deps: unknown[]; cleanup?: () => void}[], pending: [] as (() => void)[],
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: <T,>(initial?: T | (() => T)) => {
    const at = hooks.state++;
    if (!(at in hooks.states)) hooks.states[at] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.states[at], (next: T | ((previous: T) => T)) => {
      const value = typeof next === 'function' ? (next as (previous: T) => T)(hooks.states[at] as T) : next;
      if (!Object.is(value, hooks.states[at])) hooks.dirty = true;
      hooks.states[at] = value;
    }];
  },
  useRef: (value: unknown) => hooks.refs[hooks.ref++] ??= {current: value},
  useCallback: <T,>(value: T) => value,
  useEffect: effect,
  useLayoutEffect: effect,
}));
function effect(callback: () => void | (() => void), deps: unknown[]) {
  const at = hooks.effect++, previous = hooks.effects[at];
  if (!previous || deps.some((value, index) => !Object.is(value, previous.deps[index]))) hooks.pending.push(() => {
    previous?.cleanup?.(); hooks.effects[at] = {deps, cleanup: callback() || undefined};
  });
}
vi.mock('./prepare-image', () => ({prepareReaderImage: vi.fn(async (_url: string, signal: AbortSignal) => signal.throwIfAborted()),setReaderImagePriority:vi.fn()}));
import {ReaderPicture, type ReaderPictureProps} from './ReaderPicture';
import {prepareReaderImage,setReaderImagePriority} from './prepare-image';
import {msg} from '../i18n/runtime';
import {createReaderImageURL,releaseReaderImageURL,shareReaderImageURL,borrowReaderImageURL} from './image-urls';

let options: ReaderPictureProps;
let tree: ReactNode;
function render(change: Partial<ReaderPictureProps> = {}) {
  options = {...options, ...change};
  let runs = 0;
  do {
    if (++runs > 20) throw Error('Unexpected reader render loop');
    hooks.state = hooks.ref = hooks.effect = 0; hooks.dirty = false;
    tree = ReaderPicture(options);
    while (hooks.pending.length) hooks.pending.shift()!();
  } while (hooks.dirty);
}
async function flush() {for (let n = 0; n < 5; n++) await Promise.resolve(); render();}
type ImageProps = {src: string; alt: string; className: string; 'data-result-job': string; onLoad(event: unknown): void; onError():void};
function images(node: ReactNode): ImageProps[] {
  if (Array.isArray(node)) return node.flatMap(child => images(child));
  if (!isValidElement<ImageProps & {children?: ReactNode}>(node)) return [];
  return node.type === 'img' ? [node.props] : images(node.props.children);
}
function displayed() {const image = images(tree).find(image => image.className === 'nc-page-image-pending'); expect(image).toBeDefined(); image!.onLoad({currentTarget: {naturalWidth: 800, naturalHeight: 1200}}); render();}
function previewCanvas(node:ReactNode):{ref:{current:unknown};style:{display?:string}}|undefined{
  if(Array.isArray(node))return node.map(previewCanvas).find(Boolean);
  if(!isValidElement<{ref:{current:unknown};style:{display?:string};children?:ReactNode}>(node))return;
  return node.type==='canvas'?node.props:previewCanvas(node.props.children);
}
function cleanup() {for (const effect of hooks.effects) effect?.cleanup?.(); hooks.effects = [];}
type Lease={blob:Blob;release():void};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
function controlledReads(){
  const reads:{key:string;signal:AbortSignal;release:ReturnType<typeof vi.fn>;resolve:()=>void;reject:(error:Error)=>void}[]=[];
  const acquire=vi.fn<ReaderPictureProps['acquire']>((key,signal)=>{const pending=deferred<Lease>(),release=vi.fn();reads.push({key,signal,release,resolve:()=>pending.resolve({blob:new Blob([key]),release}),reject:pending.reject});return pending.promise;});
  return {acquire,reads};
}
const translatedJob={id:'translated-job'} as NonNullable<ReaderPictureProps['job']>;
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = [];
  let id = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:reader-test-${++id}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.mocked(prepareReaderImage).mockReset().mockImplementation(async(_url,signal)=>signal.throwIfAborted());
  vi.mocked(setReaderImagePriority).mockClear();
  options = {scope: 'slot-1', blobKey: 'original', alt: 'Page 1', onImport: vi.fn(),
    acquire: vi.fn(async () => ({blob: new Blob(['image']), release: vi.fn()}))};
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

describe('shared reader pixel presentation', () => {
  it('validates a foreground lease before reusing prepared turn-preview pixels without another decode',async()=>{
    const url=createReaderImageURL(new Blob(['prepared'])),id=JSON.stringify(['slot-1','original',undefined]),unpublish=shareReaderImageURL(id,url);
    const {acquire,reads}=controlledReads();render({acquire});expect(images(tree)).toHaveLength(0);expect(acquire).toHaveBeenCalledOnce();
    reads[0].resolve();await flush();expect(images(tree)[0].src).toBe(url);expect(prepareReaderImage).not.toHaveBeenCalled();
    displayed();unpublish();releaseReaderImageURL(url);expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    cleanup();expect(reads[0].release).toHaveBeenCalledOnce();expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
  });
  it('shares a preview display URL without sharing reading evidence and removes it when the preview unmounts',async()=>{
    const id=JSON.stringify(['slot-1','original',undefined]);render({shareForTurn:true});await flush();
    const borrowed=borrowReaderImageURL(id)!;expect(borrowed).toBe(images(tree)[0].src);displayed();
    cleanup();expect(borrowReaderImageURL(id)).toBeUndefined();expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    releaseReaderImageURL(borrowed);expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(borrowed);
  });
  it('cannot reuse prepared pixels across a different page scope',async()=>{
    const url=createReaderImageURL(new Blob(['old scope'])),unpublish=shareReaderImageURL(JSON.stringify(['other-scope','original',undefined]),url);
    render();await flush();expect(images(tree)[0].src).not.toBe(url);expect(prepareReaderImage).toHaveBeenCalledOnce();
    unpublish();releaseReaderImageURL(url);
  });
  it('never displays a shared preview URL when source access is rejected',async()=>{
    const url=createReaderImageURL(new Blob(['preview'])),unpublish=shareReaderImageURL(JSON.stringify(['slot-1','original',undefined]),url);
    render({acquire:vi.fn(async()=>{throw Error('access revoked');})});await flush();
    expect(images(tree)).toHaveLength(0);expect(prepareReaderImage).not.toHaveBeenCalled();unpublish();releaseReaderImageURL(url);
  });
  it('shares an in-flight preview URL so its next owner does not start a second decode',async()=>{
    const decode=deferred<void>();vi.mocked(prepareReaderImage).mockReturnValueOnce(decode.promise);
    render({shareForTurn:true});await flush();expect(images(tree)).toHaveLength(0);
    const borrowed=borrowReaderImageURL(JSON.stringify(['slot-1','original',undefined]))!;expect(borrowed).toBe('blob:reader-test-1');
    cleanup();expect(URL.revokeObjectURL).not.toHaveBeenCalled();decode.resolve();await Promise.resolve();
    releaseReaderImageURL(borrowed);expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(borrowed);
  });
  it('shows streamed pixels while reading without committing identity, then releases the canvas after final display',async()=>{
    const {acquire,reads}=controlledReads(),shown=vi.fn(),states=vi.fn();render({acquire,onShown:shown,onLoadState:states});
    const drawImage=vi.fn(),canvas={width:1,height:1,getContext:()=>({drawImage})};previewCanvas(tree)!.ref.current=canvas;
    const preview=acquire.mock.calls[0][2]!,frame={displayWidth:2400,displayHeight:3600} as VideoFrame;
    expect(preview.active()).toBe(true);preview.draw(frame);render();expect(canvas.width).toBe(2400);expect(previewCanvas(tree)!.style.display).toBeUndefined();
    expect(shown.mock.calls.some(([value])=>value?.key)).toBe(false);expect(states).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reading',originalSettled:false}));
    reads[0].resolve();await flush();expect(previewCanvas(tree)!.style.display).toBeUndefined();
    displayed();expect(previewCanvas(tree)!.style.display).toBe('none');expect(canvas.width).toBe(1);expect(preview.active()).toBe(false);
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({key:'original'}));expect(drawImage).toHaveBeenCalledOnce();
  });
  it('discards failed and retired previews and ignores late frames without restarting the source',async()=>{
    const {acquire,reads}=controlledReads();render({acquire});const drawImage=vi.fn(),canvas={width:1,height:1,getContext:()=>({drawImage})};previewCanvas(tree)!.ref.current=canvas;
    const preview=acquire.mock.calls[0][2]!,frame={displayWidth:800,displayHeight:1200} as VideoFrame;
    preview.draw(frame);render();preview.clear();render();expect(canvas.width).toBe(1);expect(previewCanvas(tree)!.style.display).toBe('none');
    preview.draw(frame);render();reads[0].reject(Error('network failed'));await flush();expect(canvas.width).toBe(1);expect(previewCanvas(tree)!.style.display).toBe('none');
    render({scope:'next',blobKey:'next'});preview.draw(frame);render();expect(drawImage).toHaveBeenCalledTimes(2);expect(acquire).toHaveBeenCalledTimes(2);
  });
  it('promotes a queued neighbor without reacquiring bytes or restarting preparation',async()=>{
    const pending=deferred<void>();vi.mocked(prepareReaderImage).mockReturnValueOnce(pending.promise);
    render({priority:'prefetch'});await flush();
    expect(prepareReaderImage).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1',expect.any(AbortSignal),'prefetch');
    render({priority:'current'});
    expect(setReaderImagePriority).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1','current');
    render({priority:'prefetch'});expect(setReaderImagePriority).toHaveBeenLastCalledWith('blob:reader-test-1','prefetch');
    expect(options.acquire).toHaveBeenCalledOnce();expect(prepareReaderImage).toHaveBeenCalledOnce();
    pending.resolve();await flush();displayed();
  });
  it('uses current priority if the page becomes visible while source bytes are pending',async()=>{
    const {acquire,reads}=controlledReads();render({priority:'prefetch',acquire});
    render({priority:'current'});reads[0].resolve();await flush();
    expect(prepareReaderImage).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1',expect.any(AbortSignal),'current');
    expect(acquire).toHaveBeenCalledOnce();
  });
  it('commits only after the actual display loads and releases its URL and source lease on removal', async () => {
    const release = vi.fn(), shown = vi.fn();
    render({acquire: vi.fn(async () => ({blob: new Blob(['image']), release})), onShown: shown});
    await flush();
    expect(shown.mock.calls.some(([value]) => value?.key === 'original')).toBe(false);
    displayed();
    expect(shown).toHaveBeenCalledWith(expect.objectContaining({key: 'original'}));
    cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1');
  });
  it('keeps the previous displayed image while a replacement fails', async () => {
    render(); await flush(); displayed();
    render({blobKey: 'translated', acquire: vi.fn(async () => {throw Error('result unavailable');})});
    await flush();
    expect(images(tree).map(image => image.src)).toEqual(['blob:reader-test-1']);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:reader-test-1');
    cleanup(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-test-1');
  });
  it('revalidates an unchanged key after a source-scope change and drops old pixels even if access fails',async()=>{
    const release=vi.fn(),shown=vi.fn(),state=vi.fn();
    const acquire=vi.fn<ReaderPictureProps['acquire']>()
      .mockResolvedValueOnce({blob:new Blob(['old source']),release})
      .mockRejectedValueOnce(Error('Source access revoked'));
    render({scope:'source-generation-1',blobKey:'unchanged-page-reference',acquire,onShown:shown,onLoadState:state});
    await flush();displayed();expect(images(tree)).toHaveLength(1);
    render({scope:'source-generation-2'});
    expect(images(tree)).toHaveLength(0);
    expect(shown).toHaveBeenLastCalledWith(undefined);
    await flush();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(images(tree)).toHaveLength(0);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({scope:'source-generation-2',phase:'error'}));
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1');
  });
  it('identifies original and translated pixels through the displayed job', async () => {
    render(); await flush(); displayed();
    expect(images(tree)[0]).toMatchObject({alt: `Page 1${msg('原图')}`, 'data-result-job': 'original'});
    render({blobKey: 'translated', job: {id: 'translated-job'} as NonNullable<ReaderPictureProps['job']>});
    await flush(); displayed();
    expect(images(tree)[0]).toMatchObject({alt: `Page 1${msg('译图')}`, 'data-result-job': 'translated-job'});
  });
  it('restarts a failed source read when its resource key changes without a manual retry or remount', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<{blob: Blob; release(): void}>((_resolve, fail) => {reject = fail;});
    const acquire = vi.fn<ReaderPictureProps['acquire']>(async () => ({blob: new Blob(['recovered']), release: vi.fn()})).mockImplementationOnce(() => pending);
    const state = vi.fn(), first = 'source-version-one';
    render({blobKey: first, acquire, onLoadState: state});
    reject(Error('Source changed')); await flush();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'error', error: 'Source changed'}));
    render({blobKey: first}); await flush(); expect(acquire).toHaveBeenCalledOnce();
    render({blobKey: 'source-version-two'}); await flush();
    expect(acquire).toHaveBeenCalledTimes(2); displayed();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase: 'ready', error: undefined}));
    expect(images(tree).map(image => image.src)).toEqual(['blob:reader-test-1']);
  });
  it('releases displayed pixels when hidden by unmount and loads a fresh image when shown again', async () => {
    const release=vi.fn(),acquire=vi.fn(async()=>({blob:new Blob(['image']),release}));
    render({acquire});await flush();displayed();
    expect(images(tree).map(image=>image.src)).toEqual(['blob:reader-test-1']);
    cleanup();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:reader-test-1');
    // A new visible image window mounts a fresh picture after releasing its old pixels.
    hooks.states=[];hooks.refs=[];hooks.pending=[];
    render();await flush();displayed();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(images(tree).map(image=>image.src)).toEqual(['blob:reader-test-2']);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:reader-test-2');
    cleanup();
    expect(release).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-test-2');
  });
  it('aborts hidden work and releases a lease that arrives after unmount without making a URL', async () => {
    let finish!: (lease: {blob: Blob; release(): void}) => void;
    let signal!: AbortSignal;
    const release = vi.fn();
    render({acquire: vi.fn((_key: string, incoming: AbortSignal) => {signal = incoming; return new Promise<{blob: Blob; release(): void}>(resolve => {finish = resolve;});})});
    cleanup(); expect(signal.aborted).toBe(true);
    finish({blob: new Blob(['late']), release});
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('shows a cold original independently while a selected remote result is pending',async()=>{
    const {acquire,reads}=controlledReads(),shown=vi.fn(),state=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onShown:shown,onLoadState:state});
    expect(reads.map(read=>read.key)).toEqual(['original','translated']);
    reads[0].resolve();await flush();displayed();
    expect(images(tree)).toHaveLength(1);
    expect(images(tree)[0]['data-result-job']).toBe('original');
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({key:'original',job:undefined}));
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({key:'translated',phase:'reading',originalSettled:true}));
    expect(reads[0].signal.aborted).toBe(false);
    expect(reads[0].release).not.toHaveBeenCalled();
    reads[1].resolve();await flush();
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({key:'original'}));
    displayed();
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({key:'translated',job:translatedJob}));
    expect(reads[0].release).toHaveBeenCalledOnce();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'ready'}));
  });
  it('does not let a failed result prevent a cold original from displaying or count as original settlement',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn(),shown=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state,onShown:shown});
    reads[1].reject(Error('remote result unavailable'));await flush();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'error',originalSettled:false}));
    expect(shown.mock.calls.some(([image])=>image?.job)).toBe(false);
    reads[0].resolve();await flush();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('original');
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'error',originalSettled:true}));
    expect(reads[0].release).not.toHaveBeenCalled();
  });
  it('offers an independent original retry without restarting a pending remote result',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state});
    reads[0].reject(Error('original unavailable'));await flush();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({key:'translated',phase:'error',error:'original unavailable',originalSettled:true}));
    state.mock.lastCall![0].retry();render();
    expect(reads.map(read=>read.key)).toEqual(['original','translated','original']);
    expect(reads[1].signal.aborted).toBe(false);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reading',originalSettled:false}));
    reads[2].reject(Error('original still unavailable'));await flush();
    reads[1].resolve();await flush();displayed();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'ready',error:undefined}));
    expect(images(tree)[0]['data-result-job']).toBe('translated-job');
  });
  it('has no original to wait for when only a remote result reference is available',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn();
    render({acquire,blobKey:'translated',originalKey:undefined,job:translatedJob,onLoadState:state});
    expect(reads.map(read=>read.key)).toEqual(['translated']);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reading',originalSettled:true}));
  });
  it('does not use the previous original lease as settlement for a replacement original key',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state});
    reads[0].resolve();await flush();displayed();
    render({originalKey:'new-original'});
    expect(reads.map(read=>read.key)).toEqual(['original','translated','new-original']);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reading',originalSettled:false}));
    expect(reads[0].release).toHaveBeenCalledOnce();
    reads[2].resolve();await flush();displayed();
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reading',originalSettled:true}));
    expect(images(tree)[0]['data-result-job']).toBe('original');
  });
  it('keeps an original read alive when a translation reference arrives and when it is removed',async()=>{
    const {acquire,reads}=controlledReads();
    render({acquire,originalKey:'original'});
    render({blobKey:'translated',job:translatedJob});
    expect(reads.map(read=>read.key)).toEqual(['original','translated']);
    expect(reads[0].signal.aborted).toBe(false);
    render({blobKey:'original',job:undefined});
    expect(reads[0].signal.aborted).toBe(false);
    expect(reads[1].signal.aborted).toBe(true);
    reads[1].resolve();reads[0].resolve();await flush();displayed();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(reads[1].release).toHaveBeenCalledOnce();
    expect(images(tree)[0]['data-result-job']).toBe('original');
  });
  it('does not restart or abort original decoding when the selected result changes',async()=>{
    const decoding=deferred<void>(),{acquire,reads}=controlledReads();let decodeSignal!:AbortSignal;
    vi.mocked(prepareReaderImage).mockImplementationOnce((_url,signal)=>{decodeSignal=signal;return decoding.promise;});
    render({acquire,originalKey:'original'});reads[0].resolve();await flush();
    render({blobKey:'translated',job:translatedJob});
    expect(decodeSignal.aborted).toBe(false);
    expect(reads.map(read=>read.key)).toEqual(['original','translated']);
    decoding.resolve();await flush();displayed();
    expect(images(tree)[0].src).toBe('blob:reader-test-1');
    expect(reads[0].release).not.toHaveBeenCalled();
  });
  it('keeps an original awaiting its actual DOM load when translation and enhancement state arrive',async()=>{
    const {acquire,reads}=controlledReads();
    render({acquire,originalKey:'original'});reads[0].resolve();await flush();
    const original=images(tree)[0];
    render({blobKey:'translated',job:translatedJob,enhancement:{identity:'enhanced-result',retry:vi.fn()}});
    expect(images(tree)[0].src).toBe(original.src);
    expect(reads[0].signal.aborted).toBe(false);
    original.onLoad({currentTarget:{naturalWidth:800,naturalHeight:1200}});render();
    expect(images(tree)[0].className).toBe('nc-page-image');
    expect(reads.filter(read=>read.key==='original')).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(original.src);
  });
  it.each([undefined,{phase:'queued' as const},{phase:'running' as const},{phase:'error' as const,message:'enhancement failed'}])('does not gate ordinary pixels on enhancement cache or state %j',async state=>{
    const {acquire,reads}=controlledReads();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,enhancement:{identity:'enhanced',state,retry:vi.fn()}});
    expect(reads.map(read=>read.key)).toEqual(['original','translated']);
    reads[0].resolve();await flush();displayed();
    reads[1].resolve();await flush();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('translated-job');
    expect(acquire).toHaveBeenCalledTimes(2);
  });
  it('reuses ordinary pixels through enhancement state changes and swaps only after enhanced DOM load',async()=>{
    const {acquire,reads}=controlledReads(),retry=vi.fn(),shown=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onShown:shown,enhancement:{identity:'enhanced',retry}});
    reads[1].resolve();await flush();displayed();const translated=images(tree)[0].src;
    for(const phase of ['queued','running','error'] as const)render({enhancement:{identity:'enhanced',state:{phase},retry}});
    expect(acquire).toHaveBeenCalledTimes(2);
    render({enhancement:{identity:'enhanced',state:{phase:'ready'},blob:new Blob(['enhanced']),retry}});await flush();
    expect(images(tree).find(image=>image.className==='nc-page-image')?.src).toBe(translated);
    expect(reads[1].release).not.toHaveBeenCalled();
    displayed();
    expect(images(tree)[0].src).not.toBe(translated);
    expect(reads[1].release).toHaveBeenCalledOnce();
    expect(shown.mock.calls.filter(([image])=>image?.job?.id==='translated-job')).toHaveLength(1);
  });
  it('does not cancel an original decode when an enhanced result arrives',async()=>{
    const originalDecode=deferred<void>(),enhancedDecode=deferred<void>(),{acquire,reads}=controlledReads();let originalSignal!:AbortSignal;
    vi.mocked(prepareReaderImage).mockImplementationOnce((_url,signal)=>{originalSignal=signal;return originalDecode.promise;}).mockImplementationOnce(()=>enhancedDecode.promise);
    render({acquire,originalKey:'original'});reads[0].resolve();await flush();
    render({enhancement:{identity:'enhanced-original',blob:new Blob(['enhanced']),state:{phase:'ready'},retry:vi.fn()}});await flush();
    expect(originalSignal.aborted).toBe(false);
    originalDecode.resolve();await flush();displayed();const original=images(tree)[0].src;
    expect(acquire).toHaveBeenCalledOnce();
    enhancedDecode.resolve();await flush();
    expect(images(tree).find(image=>image.className==='nc-page-image')?.src).toBe(original);
    displayed();expect(images(tree)[0].src).not.toBe(original);
    expect(reads[0].release).toHaveBeenCalledOnce();
  });
  it('uses an already supplied enhanced blob without reading either parent',async()=>{
    const {acquire}=controlledReads();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,enhancement:{identity:'enhanced',blob:new Blob(['enhanced']),state:{phase:'ready'},retry:vi.fn()}});
    await flush();expect(acquire).not.toHaveBeenCalled();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('translated-job');
    cleanup();expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it('falls back through the same loader if a supplied enhancement cannot decode',async()=>{
    const {acquire,reads}=controlledReads();
    vi.mocked(prepareReaderImage).mockRejectedValueOnce(Error('enhanced image is invalid'));
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,enhancement:{identity:'enhanced',blob:new Blob(['bad enhanced']),state:{phase:'ready'},retry:vi.fn()}});
    await flush();expect(reads.map(read=>read.key)).toEqual(['original','translated']);
    reads[0].resolve();await flush();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('original');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:reader-test-1');
  });
  it('does not let a late original replace a result that has already displayed',async()=>{
    const {acquire,reads}=controlledReads(),shown=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onShown:shown});
    reads[1].resolve();await flush();displayed();
    expect(reads[0].signal.aborted).toBe(true);
    reads[0].resolve();await flush();
    expect(reads[0].release).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(shown).toHaveBeenLastCalledWith(expect.objectContaining({key:'translated',job:translatedJob}));
  });
  it('does not start a newly provided fallback when the selected result is already displayed',async()=>{
    const acquire=vi.fn(async()=>({blob:new Blob(['translated']),release:vi.fn()}));
    render({acquire,blobKey:'translated',job:translatedJob});await flush();displayed();
    render({originalKey:'original'});await flush();
    expect(acquire).toHaveBeenCalledOnce();
    expect(images(tree)[0]['data-result-job']).toBe('translated-job');
  });
  it('retries only a failed selected result while preserving the displayed original and lease',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state});
    reads[0].resolve();reads[1].reject(Error('offline'));await flush();displayed();const original=images(tree)[0].src;
    state.mock.lastCall![0].retry();render();
    expect(reads.map(read=>read.key)).toEqual(['original','translated','translated']);
    expect(reads[0].release).not.toHaveBeenCalled();
    expect(images(tree)[0].src).toBe(original);
    reads[2].resolve();await flush();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('translated-job');
    expect(reads[0].release).toHaveBeenCalledOnce();
  });
  it('rejects a failed display candidate without discarding the original fallback',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state});
    reads[0].resolve();await flush();displayed();const original=images(tree)[0].src;
    reads[1].resolve();await flush();images(tree).find(image=>image.className==='nc-page-image-pending')!.onError();render();
    expect(images(tree).map(image=>image.src)).toEqual([original]);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({phase:'error',originalSettled:true}));
    expect(reads[0].release).not.toHaveBeenCalled();
  });
  it('keeps at most the original and current selected-result read across repeated target changes',async()=>{
    const {acquire,reads}=controlledReads();
    render({acquire,originalKey:'original',blobKey:'translated-0',job:translatedJob});
    for(let n=1;n<=5;n++){
      render({blobKey:`translated-${n}`});
      expect(reads.filter(read=>!read.signal.aborted)).toHaveLength(2);
    }
    expect(reads.filter(read=>read.key==='original')).toHaveLength(1);
    for(const read of reads.slice(1,-1))read.resolve();await flush();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(reads.slice(1,-1).every(read=>read.release.mock.calls.length===1)).toBe(true);
    reads[0].resolve();await flush();displayed();
    expect(images(tree)[0]['data-result-job']).toBe('original');
  });
  it('resets original settlement and hides all previous pixels immediately on scope changes',async()=>{
    const {acquire,reads}=controlledReads(),state=vi.fn(),shown=vi.fn();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob,onLoadState:state,onShown:shown});
    reads[0].resolve();await flush();displayed();
    render({scope:'new-source-generation'});
    expect(images(tree)).toHaveLength(0);
    expect(state).toHaveBeenLastCalledWith(expect.objectContaining({scope:'new-source-generation',originalSettled:false}));
    expect(reads.slice(0,2).every(read=>read.signal.aborted)).toBe(true);
    reads[1].resolve();await flush();
    expect(reads[1].release).toHaveBeenCalledOnce();
    expect(shown).toHaveBeenLastCalledWith(undefined);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it('releases both late original and result leases after unmount without creating pixels',async()=>{
    const {acquire,reads}=controlledReads();
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob});cleanup();
    expect(reads.every(read=>read.signal.aborted)).toBe(true);
    for(const read of reads)read.resolve();for(let n=0;n<5;n++)await Promise.resolve();
    expect(reads.every(read=>read.release.mock.calls.length===1)).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it('releases all prepared URLs and leases when unmounted with three concurrent candidates',async()=>{
    const {acquire,reads}=controlledReads(),decoding=deferred<void>();
    vi.mocked(prepareReaderImage).mockImplementation(()=>decoding.promise);
    render({acquire,originalKey:'original',blobKey:'translated',job:translatedJob});
    reads[0].resolve();reads[1].resolve();await flush();
    render({enhancement:{identity:'enhanced',blob:new Blob(['enhanced']),state:{phase:'ready'},retry:vi.fn()}});await flush();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
    cleanup();decoding.resolve();for(let n=0;n<5;n++)await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(reads.every(read=>read.release.mock.calls.length===1)).toBe(true);
  });
});
