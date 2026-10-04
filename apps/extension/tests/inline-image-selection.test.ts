import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {installImageSelection,selectedImage,selectionCurrent} from '../src/inline/selection';

class Image {
  currentSrc='https://cdn.test/same.png'; src=this.currentSrc;
  naturalWidth=80; naturalHeight=110; complete=true; isConnected=true;
  ownerDocument!:Document;
}
let listener:(event:MouseEvent)=>void,doc:Document,first:Image,duplicate:Image;
const capture=(image:Image,trusted=true)=>listener({isTrusted:trusted,composedPath:()=>[image]} as unknown as MouseEvent);
beforeEach(()=>{
  vi.stubGlobal('HTMLImageElement',Image);
  doc={defaultView:{location:{href:'https://source.test/page'},getComputedStyle:()=>({content:'normal'})},
    addEventListener:vi.fn((_type:string,fn:typeof listener)=>{listener=fn;}),removeEventListener:vi.fn()} as unknown as Document;
  first=new Image();duplicate=new Image();first.ownerDocument=duplicate.ownerDocument=doc;
  installImageSelection(doc);
});
afterEach(()=>vi.unstubAllGlobals());

describe('right-click image selection',()=>{
  it('keeps the exact small image despite a duplicate source URL',()=>{
    capture(duplicate);
    expect(selectedImage(doc,first.src)?.element).toBe(duplicate);
  });
  it('ignores synthetic context menus and clears selection on trusted non-images',()=>{
    capture(first,false);expect(selectedImage(doc,first.src)).toBeUndefined();
    capture(first);listener({isTrusted:true,composedPath:()=>[]} as unknown as MouseEvent);
    expect(selectedImage(doc,first.src)).toBeUndefined();
  });
  it.each(['source','dimensions','removed','navigation','loading'])('invalidates a %s change without finding the duplicate',change=>{
    capture(first);const snapshot=selectedImage(doc,first.src)!;
    if(change==='source')first.currentSrc='https://cdn.test/new.png';
    if(change==='dimensions')first.naturalWidth=160;
    if(change==='removed')first.isConnected=false;
    if(change==='navigation')doc.defaultView!.location.href='https://source.test/other';
    if(change==='loading')first.complete=false;
    expect(selectionCurrent(snapshot,doc)).toBe(false);
    expect(selectedImage(doc,duplicate.src)).toBeUndefined();
  });
  it('accepts the reported CSS translation URL while retaining original input',()=>{
    vi.spyOn(doc.defaultView!,'getComputedStyle').mockReturnValue({content:'url("blob:https://source.test/translation")'} as CSSStyleDeclaration);
    capture(first);
    const selected=selectedImage(doc,'blob:https://source.test/translation');
    expect(selected?.url).toBe(first.src);expect(selected?.element).toBe(first);
  });
  it('resolves a page-held data image without receiving its full URL in a message',()=>{
    first.currentSrc=first.src='data:image/png;base64,YQ==';capture(first);
    expect(selectedImage(doc,undefined,true)?.element).toBe(first);
    expect(selectedImage(doc)).toBeUndefined();
    capture(duplicate);expect(selectedImage(doc,undefined,true)).toBeUndefined();
  });
  it('cleans up the entry and its retained reference',()=>{
    const stop=installImageSelection(doc);capture(first);stop();
    expect(selectedImage(doc,first.src)).toBeUndefined();expect(doc.removeEventListener).toHaveBeenCalledWith('contextmenu',listener,true);
  });
});
