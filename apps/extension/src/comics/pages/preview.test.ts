import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PagePreview,type PagePreviewTarget} from './preview';
const jpeg=()=>new Uint8Array([255,216,255,224,0,0,0,0,0,0,0,0]);
const frame=()=>({displayWidth:2400,displayHeight:3600,close:vi.fn()}) as unknown as VideoFrame;
const target=(active=true)=>({active:vi.fn(()=>active),draw:vi.fn(),clear:vi.fn()});
async function flush(){for(let n=0;n<8;n++)await Promise.resolve();}
class Decoder {
  static all:Decoder[]=[];
  chunks:Uint8Array[]=[];
  pending:{resolve:(value:{image:VideoFrame;complete:boolean})=>void;reject:(error:Error)=>void}[]=[];
  reader:ReadableStreamDefaultReader<Uint8Array>;
  completed:Promise<void>;
  close=vi.fn(()=>{void this.reader.cancel();});
  decode=vi.fn(()=>new Promise<{image:VideoFrame;complete:boolean}>((resolve,reject)=>this.pending.push({resolve,reject})));
  constructor({data}:{data:ReadableStream<Uint8Array>}){
    Decoder.all.push(this);const reader=this.reader=data.getReader();
    this.completed=(async()=>{while(true){const item=await reader.read();if(item.done)return;this.chunks.push(item.value);}})();
  }
  emit(image=frame(),complete=false){this.pending.shift()!.resolve({image,complete});return image;}
}
beforeEach(()=>{Decoder.all=[];vi.stubGlobal('ImageDecoder',Decoder);vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('incremental page previews',()=>{
  it('shares one decoder and borrowed chunks across panes, paints before completion, and releases previous frames',async()=>{
    const preview=new PagePreview(),first=target(),second=target(),chunks=[jpeg()];
    preview.add(first);preview.add(second);preview.feed({chunks,done:false});await flush();
    const decoder=Decoder.all[0];expect(Decoder.all).toHaveLength(1);expect(decoder.chunks[0]).toBe(chunks[0]);
    const initial=decoder.emit();await flush();expect(first.draw).toHaveBeenCalledWith(initial);expect(second.draw).toHaveBeenCalledWith(initial);
    const late=target();preview.add(late);expect(late.draw).toHaveBeenCalledExactlyOnceWith(initial);
    chunks.push(new Uint8Array([1,2,3]));preview.feed({chunks,done:false});await flush();
    expect(decoder.chunks).toEqual(chunks);expect(decoder.decode).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);const final=decoder.emit(frame(),true);await flush();
    expect(initial.close).toHaveBeenCalledOnce();expect(first.draw).toHaveBeenLastCalledWith(final);
    preview.feed({chunks,done:true});await flush();await decoder.completed;
    preview.finish();expect(final.close).toHaveBeenCalledOnce();expect(decoder.close).toHaveBeenCalledOnce();expect(first.clear).not.toHaveBeenCalled();
  });
  it('starts a promoted reader from the existing download and stops when no visible consumer remains',async()=>{
    const preview=new PagePreview(),sink=target(false),chunks=[jpeg(),new Uint8Array([2])];
    const remove=preview.add(sink);preview.feed({chunks,done:false});expect(Decoder.all).toHaveLength(0);
    sink.active.mockReturnValue(true);preview.refresh();await flush();expect(Decoder.all[0].chunks).toEqual(chunks);
    remove();expect(Decoder.all[0].close).toHaveBeenCalledOnce();
    const stale=Decoder.all[0].emit();await flush();expect(stale.close).toHaveBeenCalledOnce();expect(sink.draw).not.toHaveBeenCalled();
    preview.finish();
  });
  it('does not repeatedly try a failed codec and clears pixels before a renewed source attempt',async()=>{
    const preview=new PagePreview(),sink=target(),chunks=[jpeg()];preview.add(sink);preview.feed({chunks,done:false});
    Decoder.all[0].pending.shift()!.reject(Error('unsupported image'));await flush();
    chunks.push(jpeg());preview.feed({chunks,done:false});expect(Decoder.all).toHaveLength(1);
    preview.feed(undefined);expect(sink.clear).toHaveBeenCalledOnce();preview.feed({chunks:[jpeg()],done:false});expect(Decoder.all).toHaveLength(2);
    const image=Decoder.all[1].emit();await flush();preview.finish(true);expect(image.close).toHaveBeenCalledOnce();expect(sink.clear).toHaveBeenCalledTimes(2);
  });
  it('skips completed downloads, unsupported formats, and browsers without ImageDecoder',()=>{
    const preview=new PagePreview();preview.add(target());preview.feed({chunks:[jpeg()],done:true});
    preview.feed({chunks:[new Uint8Array(24)],done:false});expect(Decoder.all).toHaveLength(0);
    vi.stubGlobal('ImageDecoder',undefined);preview.feed({chunks:[jpeg()],done:false});expect(Decoder.all).toHaveLength(0);preview.finish();
  });
  it('sniffs across small chunks instead of trusting a server MIME and isolates a broken canvas',async()=>{
    const preview=new PagePreview(),bad:PagePreviewTarget={active:()=>true,draw(){throw Error('detached');},clear(){throw Error('detached');}},good=target();
    preview.add(bad);preview.add(good);const header=jpeg(),chunks=[header.subarray(0,2)];preview.feed({chunks,done:false});expect(Decoder.all).toHaveLength(0);
    chunks.push(header.subarray(2));preview.feed({chunks,done:false});Decoder.all[0].emit();await flush();expect(good.draw).toHaveBeenCalledOnce();expect(()=>preview.finish(true)).not.toThrow();
  });
});
