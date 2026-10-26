import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Exercise the real shared lifecycle and reader controller with deterministic time.
const hooks=vi.hoisted(()=>({state:0,ref:0,effect:0,dirty:false,states:[] as unknown[],refs:[] as {current:unknown}[],effects:[] as {deps:unknown[];cleanup?:()=>void}[],pending:[] as (()=>void)[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:<T,>(initial?:T|(()=>T))=>{const n=hooks.state++;if(!(n in hooks.states))hooks.states[n]=typeof initial==='function'?(initial as ()=>T)():initial;return [hooks.states[n],(next:T|((value:T)=>T))=>{const value=typeof next==='function'?(next as (value:T)=>T)(hooks.states[n] as T):next;if(!Object.is(value,hooks.states[n]))hooks.dirty=true;hooks.states[n]=value;}];},
  useRef:(initial:unknown)=>hooks.refs[hooks.ref++]??={current:initial},
  useEffect:(callback:()=>void|(()=>void),deps:unknown[])=>{const n=hooks.effect++,previous=hooks.effects[n];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))hooks.pending.push(()=>{previous?.cleanup?.();hooks.effects[n]={deps,cleanup:callback()||undefined};});},
}));
vi.mock('../src/comics/application/bookmarks',async original=>({...await original<typeof import('../src/comics/application/bookmarks')>(),
  countBookmarks:vi.fn(async()=>0),listBookmarks:vi.fn(async()=>[]),findBookmark:vi.fn(async()=>undefined),subscribeBookmarks:()=>()=>{},
}));
import {Notification} from '../src/ui/Notification';
import {useReaderBookmarks} from '../src/reader/useReaderBookmarks';
import {BookmarkNotice,BookmarkList} from '../src/reader/ReaderBookmarks';
import type {BookmarkLocation} from '../src/comics/application/bookmarks';

function render<T>(component:()=>T){let value:T;do{hooks.state=hooks.ref=hooks.effect=0;hooks.dirty=false;value=component();while(hooks.pending.length)hooks.pending.shift()!();}while(hooks.dirty);return value!;}
function cleanup(){for(const effect of hooks.effects)effect.cleanup?.();}
function nodes(node:unknown):ReactElement<Record<string,any>>[]{if(Array.isArray(node))return node.flatMap(nodes);if(!node||typeof node!=='object'||!('props' in node))return [];const element=node as ReactElement<Record<string,any>>;return [element,...nodes(element.props.children)];}
let hidden=false;
const visibility=new EventTarget();
beforeEach(()=>{
  hooks.states=[];hooks.refs=[];hooks.effects=[];hooks.pending=[];hidden=false;
  vi.useFakeTimers();
  vi.stubGlobal('document',{get hidden(){return hidden;},addEventListener:vi.fn(visibility.addEventListener.bind(visibility)),removeEventListener:vi.fn(visibility.removeEventListener.bind(visibility))});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});

describe('shared notifications',()=>{
  let props:Parameters<typeof Notification>[0],tree:ReturnType<typeof Notification>;
  const draw=()=>{tree=render(()=>Notification(props));};
  const advance=(ms:number)=>{vi.advanceTimersByTime(ms);draw();};
  beforeEach(()=>{props={message:'Saved',tone:'info',duration:10000,onClose:vi.fn()};draw();});

  it('expires once using active time and the latest callback, without restarting on renders',()=>{
    advance(7000);const close=vi.fn();props={...props,onClose:close,children:<strong>Custom content</strong>};draw();
    expect(vi.getTimerCount()).toBe(1);advance(2999);expect(close).not.toHaveBeenCalled();advance(1);expect(close).toHaveBeenCalledOnce();
    nodes(tree).find(node=>node.props['aria-label']==='关闭提示')!.props.onClick();advance(10000);expect(close).toHaveBeenCalledOnce();
  });
  it('resumes the remaining duration after overlapping pointer and focus pauses',()=>{
    advance(3000);tree.props.onPointerEnter({pointerType:'mouse'});draw();advance(20000);
    tree.props.onFocusCapture();draw();tree.props.onPointerLeave();draw();advance(20000);expect(props.onClose).not.toHaveBeenCalled();
    tree.props.onBlurCapture({currentTarget:{contains:()=>false},relatedTarget:null});draw();
    advance(6999);expect(props.onClose).not.toHaveBeenCalled();advance(1);expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('pauses in background and while an action is pending without resetting the time',()=>{
    advance(2000);hidden=true;visibility.dispatchEvent(new Event('visibilitychange'));draw();advance(20000);
    props={...props,paused:true};hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));draw();advance(20000);
    props={...props,paused:false};draw();advance(7999);expect(props.onClose).not.toHaveBeenCalled();advance(1);expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('does not turn a touch tap into persistent hover',()=>{
    tree.props.onPointerEnter({pointerType:'touch'});draw();advance(10000);expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('does not keep a replacement notice paused when its focused action was removed',()=>{
    const contains=vi.fn(()=>true);tree.props.ref.current={contains};
    tree.props.onFocusCapture();draw();advance(10000);expect(props.onClose).not.toHaveBeenCalled();
    contains.mockReturnValue(false);props={...props,notificationKey:'completed',message:'Completed',duration:3000};draw();
    advance(2999);expect(props.onClose).not.toHaveBeenCalled();advance(1);expect(props.onClose).toHaveBeenCalledOnce();
  });
  it('restarts for a new notification even with identical text',()=>{
    props={...props,notificationKey:'first'};draw();advance(9000);props={...props,notificationKey:'second'};draw();
    advance(9999);expect(props.onClose).not.toHaveBeenCalled();advance(1);expect(props.onClose).toHaveBeenCalledOnce();
    props={...props,notificationKey:'third'};draw();advance(10000);expect(props.onClose).toHaveBeenCalledTimes(2);
  });
  it('supports custom content, action and style with no timer for an explicit persistent notice',()=>{
    const action=vi.fn();props={...props,duration:null,icon:null,className:'custom-notice',children:<strong>Custom content</strong>,action:<button onClick={action}>Retry</button>};draw();
    const markup=renderToStaticMarkup(tree);expect(markup).toContain('custom-notice');expect(markup).toContain('<strong>Custom content</strong>');expect(markup).toContain('Retry');expect(markup).not.toContain('<p>Saved</p>');
    expect(vi.getTimerCount()).toBe(0);advance(60000);expect(props.onClose).not.toHaveBeenCalled();
    nodes(tree).find(node=>node.props.onClick===action)!.props.onClick();expect(action).toHaveBeenCalledOnce();expect(props.onClose).not.toHaveBeenCalled();
  });
  it('leaves IME Escape alone and dismisses only this notification for an ordinary Escape',()=>{
    const event={key:'Escape',defaultPrevented:false,nativeEvent:{isComposing:true,keyCode:229},preventDefault:vi.fn(),stopPropagation:vi.fn()};
    tree.props.onKeyDown(event);expect(props.onClose).not.toHaveBeenCalled();
    event.nativeEvent={isComposing:false,keyCode:27};tree.props.onKeyDown(event);expect(props.onClose).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it('cleans the timer and visibility listener when unmounted',()=>{
    const listener=vi.mocked(document.addEventListener).mock.calls[0][1];cleanup();
    expect(vi.getTimerCount()).toBe(0);expect(document.removeEventListener).toHaveBeenCalledWith('visibilitychange',listener);
    vi.advanceTimersByTime(20000);expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe('bookmark feedback and retained return position',()=>{
  const previous:BookmarkLocation={comicId:'comic',entryId:'chapter',contentId:'content',title:'Chapter',pageId:'page-1',pageNumber:1,relativeOffset:.42};
  const destination={...previous,pageId:'page-3',pageNumber:3,relativeOffset:.2};
  let b:ReturnType<typeof useReaderBookmarks>,props:Parameters<typeof useReaderBookmarks>[0];
  const draw=()=>{b=render(()=>useReaderBookmarks(props));};
  beforeEach(()=>{props={comicId:'comic',current:previous,open:false,capture:()=>previous,navigate:vi.fn(async()=>true),close:vi.fn()};draw();});
  it('shares Notification and retains a discoverable return entry after either timed or manual dismissal',async()=>{
    await b.jump(destination);draw();const feedback=BookmarkNotice({bookmarks:b})!;
    expect(feedback.type).toBe(Notification);expect(feedback.props.duration).toBe(10000);expect(b.returnTo).toEqual(previous);
    feedback.props.onClose();draw();expect(b.notice).toBeUndefined();expect(b.returnTo).toEqual(previous);expect(BookmarkNotice({bookmarks:b})).toBeNull();
    const back=nodes(BookmarkList({bookmarks:b})).find(node=>node.type==='button'&&node.props.children==='返回刚才');expect(back).toBeDefined();
    await b.goBack();draw();expect(props.navigate).toHaveBeenLastCalledWith(previous);expect(b.returnTo).toBeUndefined();expect(b.notice).toBeUndefined();
  });
  it('retains return position through a failed return and allows retry',async()=>{
    await b.jump(destination);draw();b.dismiss();draw();vi.mocked(props.navigate).mockResolvedValueOnce(false);
    expect(await b.goBack()).toBe(false);draw();expect(b.returnTo).toEqual(previous);expect(b.notice?.tone).toBe('error');expect(props.close).toHaveBeenCalledTimes(1);
    b.dismiss();draw();expect(b.returnTo).toEqual(previous);expect(await b.goBack()).toBe(true);draw();expect(b.returnTo).toBeUndefined();
  });
  it('pauses feedback and prevents duplicate return navigation until the operation settles',async()=>{
    await b.jump(destination);draw();let resolve!:(value:boolean)=>void;vi.mocked(props.navigate).mockImplementationOnce(()=>new Promise<boolean>(done=>{resolve=done;}));
    const pending=b.goBack();draw();expect(BookmarkNotice({bookmarks:b})!.props.paused).toBe(true);
    expect(await b.goBack()).toBe(false);expect(props.navigate).toHaveBeenCalledTimes(2);resolve(true);await pending;draw();expect(b.busy).toBe(false);expect(b.returnTo).toBeUndefined();
  });
  it('replaces the single return position only after a new successful bookmark jump',async()=>{
    await b.jump(destination);draw();props={...props,capture:()=>destination};draw();
    await b.jump({...destination,pageId:'page-5',pageNumber:5});draw();expect(b.returnTo).toEqual(destination);
    vi.mocked(props.navigate).mockRejectedValueOnce(Error('offline'));expect(await b.goBack()).toBe(false);draw();expect(b.returnTo).toEqual(destination);expect(b.notice?.tone).toBe('error');
  });
});
