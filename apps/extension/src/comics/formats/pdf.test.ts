import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const pdf=vi.hoisted(()=>({options:undefined as unknown as {worker:{port:Worker};disableAutoFetch:boolean;disableStream:boolean;range:{requestDataRange(begin:number,end:number):void}},open:vi.fn(),getPage:vi.fn(),original:vi.fn(),destroy:vi.fn(),workerDestroy:vi.fn(),workerStart:vi.fn(),terminate:vi.fn(),render:vi.fn(),cleanup:vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({PDFWorker:class{static create(options:{port:unknown}){return new this(options);}port:unknown;constructor({port}:{port:unknown}){this.port=port;}destroy=pdf.workerDestroy;},PDFDataRangeTransport:class{constructor(public length:number,public initial:Uint8Array){}onDataRange(){}},getDocument:(options:typeof pdf.options)=>{pdf.options=options;return {promise:pdf.open(),destroy:pdf.destroy};}}));
import {openPdfDocument} from './pdf';
import type {RandomAccessSource} from './contracts';
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('location',{origin:'chrome-extension://fixture'});
  vi.stubGlobal('Worker',class extends EventTarget{constructor(url:string,options:WorkerOptions){super();pdf.workerStart(url,options);}terminate=pdf.terminate;});
  pdf.open.mockResolvedValue({numPages:3,getPage:pdf.getPage,_transport:{messageHandler:{sendWithPromise:pdf.original}}});
  pdf.destroy.mockResolvedValue(undefined);pdf.render.mockImplementation(()=>({promise:Promise.resolve(),cancel:vi.fn()}));
  pdf.getPage.mockImplementation(async()=>({getViewport:({scale}:{scale:number})=>({width:300*scale,height:500*scale}),render:pdf.render,cleanup:pdf.cleanup}));
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,toBlob:(done:(blob:Blob)=>void)=>done(new Blob(['rendered'],{type:'image/png'}))})});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
function source(){const readAt=vi.fn(async(_offset:number,length:number,signal?:AbortSignal)=>{signal?.throwIfAborted();return new Uint8Array(length);});const value:RandomAccessSource={snapshot:{identity:'pdf',version:'1',size:200000,local:true},readAt,async validate(){return 'unchanged';},async close(){}};return {value,readAt};}
describe('PDF range and page-render contract',()=>{
  it('indexes page numbers without rendering and disables automatic whole-document fetching',async()=>{
    const {value,readAt}=source(),session=await openPdfDocument(value);
    try{expect(await session.index()).toHaveLength(3);expect(pdf.getPage).not.toHaveBeenCalled();expect(readAt).toHaveBeenCalledTimes(1);expect(readAt.mock.calls[0].slice(0,2)).toEqual([0,65536]);expect(pdf.options).toMatchObject({disableAutoFetch:true,disableStream:true});
      expect(pdf.workerStart).toHaveBeenCalledExactlyOnceWith('chrome-extension://fixture/import-assets/pdf/pdf.worker.mjs',{type:'module'});
      expect(pdf.options.worker.port).toBeInstanceOf(Worker);
      const pages=await session.index(),blob=await session.materialize(pages[2]);expect(blob.type).toBe('image/png');expect(pdf.getPage).toHaveBeenCalledExactlyOnceWith(3);expect(pdf.cleanup).toHaveBeenCalledOnce();
    }finally{await session.close();}
  });
  it('preserves Safari runtime resource URLs',async()=>{
    vi.stubGlobal('location',{origin:'safari-web-extension://lowercase'});
    vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>'safari-web-extension://UPPERCASE/'+path}});
    const session=await openPdfDocument(source().value);
    expect(pdf.workerStart).toHaveBeenCalledWith('safari-web-extension://UPPERCASE/import-assets/pdf/pdf.worker.mjs',{type:'module'});
    await session.close();expect(pdf.workerDestroy).toHaveBeenCalledTimes(1);expect(pdf.terminate).toHaveBeenCalledTimes(1);
  });
  it('reads requested ranges and indexes more than 1500 pages without a PDF-specific budget',async()=>{
    pdf.open.mockResolvedValue({numPages:1501,getPage:pdf.getPage});
    const {value,readAt}=source();value.snapshot.size=20*1024*1024;
    const session=await openPdfDocument(value);
    try{
      expect(await session.index()).toHaveLength(1501);
      pdf.options.range.requestDataRange(0,17*1024*1024);
      expect(pdf.destroy).not.toHaveBeenCalled();expect(readAt).toHaveBeenCalledTimes(2);
      expect(readAt.mock.calls[1].slice(0,2)).toEqual([0,17*1024*1024]);
    }
    finally{await session.close();}
  });
  it('honors display resolution without a canvas ceiling or changing translation bytes and geometry',async()=>{
    pdf.getPage.mockImplementation(async()=>({getViewport:({scale}:{scale:number})=>({width:5000*scale,height:6000*scale}),render:pdf.render,cleanup:pdf.cleanup}));
    const canvas={width:0,height:0,toBlob:(done:(blob:Blob)=>void)=>done(new Blob([`${canvas.width}x${canvas.height}`],{type:'image/png'}))};
    vi.stubGlobal('document',{createElement:()=>canvas});
    const session=await openPdfDocument(source().value);
    try{
      const [page]=await session.index(),before=await session.materialize(page);
      expect(await before.text()).toBe('10000x12000');
      for(const width of [1250,20000]){
        const display=await session.renderForDisplay!(page,width);
        expect(display).toMatchObject({width:10000,height:12000});
        expect(await display.blob.text()).toBe(`${width}x${Math.floor(width*6000/5000)}`);
      }
      expect(await (await session.materialize(page)).text()).toBe(await before.text());
    }finally{await session.close();}
  });
  it('honors cancellation before the initial header read',async()=>{
    const {value,readAt}=source(),controller=new AbortController();controller.abort();await expect(openPdfDocument(value,controller.signal)).rejects.toThrow();expect(readAt).not.toHaveBeenCalled();
  });
  it.each([
    ['PasswordException','No password given','PDF 已加密，当前只支持未加密文件。'],
    ['InvalidPDFException','Invalid PDF structure.','PDF 文件结构损坏，无法建立目录。'],
  ])('explains %s without exposing the PDF parser diagnostic',async(name,message,expected)=>{
    pdf.open.mockRejectedValue(Object.assign(new Error(message),{name}));
    await expect(openPdfDocument(source().value)).rejects.toThrow(expected);expect(pdf.destroy).toHaveBeenCalledOnce();
  });
  it.each(['header','opening','page','render','encode','original'] as const)('cancels a pending %s without waiting for PDF.js or its destroy acknowledgement',async phase=>{
    const {value,readAt}=source(),entered=Promise.withResolvers<void>(),controller=new AbortController();
    const failure=new DOMException('cancelled by reader','AbortError'),cancel=vi.fn();
    const pending=()=>{entered.resolve();return new Promise<never>(()=>{});};
    pdf.destroy.mockReturnValue(new Promise(()=>{}));
    if(phase==='header')readAt.mockImplementation(pending);
    if(phase==='opening'){vi.useFakeTimers();pdf.open.mockImplementation(pending);}
    if(phase==='page')pdf.getPage.mockImplementation(pending);
    if(phase==='render')pdf.render.mockImplementation(()=>({promise:pending(),cancel}));
    if(phase==='encode')vi.stubGlobal('document',{createElement:()=>({width:0,height:0,toBlob:()=>{entered.resolve();}})});
    if(phase==='original')pdf.original.mockImplementation(pending);
    const reading=(async()=>{
      const session=await openPdfDocument(value,phase==='header'||phase==='opening'?controller.signal:undefined);
      try{
        const [page]=await session.index();
        await (phase==='original'?session.originalImage!(page,controller.signal):session.materialize(page,controller.signal));
      }finally{await session.close();}
    })();
    const rejected=expect(reading).rejects.toBe(failure);
    await entered.promise;
    if(phase==='opening'){await vi.advanceTimersByTimeAsync(120000);expect(pdf.destroy).not.toHaveBeenCalled();}
    controller.abort(failure);await rejected;
    if(phase==='header')expect(pdf.workerStart).not.toHaveBeenCalled();
    else{expect(pdf.destroy).toHaveBeenCalledOnce();expect(pdf.workerDestroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();}
    if(phase==='render'){expect(cancel).toHaveBeenCalledOnce();expect(pdf.cleanup).toHaveBeenCalledOnce();}
  });
  it('propagates a range failure to the active render and closes the worker once',async()=>{
    const {value,readAt}=source(),failure=new Error('source unavailable'),entered=Promise.withResolvers<void>(),cancel=vi.fn();
    const session=await openPdfDocument(value),[page]=await session.index();
    pdf.destroy.mockReturnValue(new Promise(()=>{}));
    pdf.render.mockImplementation(()=>{entered.resolve();return {promise:new Promise(()=>{}),cancel};});
    const reading=session.materialize(page),rejected=expect(reading).rejects.toBe(failure);
    await entered.promise;readAt.mockRejectedValue(failure);pdf.options.range.requestDataRange(65536,131072);
    await rejected;await session.close();
    expect(cancel).toHaveBeenCalledOnce();expect(pdf.destroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
  it.each(['error','messageerror'])('fails a pending open on worker %s and does not expose worker diagnostics',async type=>{
    const entered=Promise.withResolvers<void>();pdf.open.mockImplementation(()=>{entered.resolve();return new Promise(()=>{});});
    pdf.destroy.mockReturnValue(new Promise(()=>{}));
    const opening=openPdfDocument(source().value),rejected=expect(opening).rejects.toMatchObject({message:'PDF 读取失败，请重试。'});
    const event=Object.assign(new Event(type,{cancelable:true}),{message:'private parser details'});
    await entered.promise;pdf.options.worker.port.dispatchEvent(event);await rejected;expect(event.defaultPrevented).toBe(true);
    expect(pdf.destroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
  it('releases an allocated worker when parser initialization throws synchronously',async()=>{
    const failure=new Error('parser initialization failed');pdf.open.mockImplementation(()=>{throw failure;});
    await expect(openPdfDocument(source().value)).rejects.toBe(failure);
    expect(pdf.destroy).not.toHaveBeenCalled();expect(pdf.workerDestroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
  it('shares normal teardown across repeated close calls and rejects reuse of a closed session',async()=>{
    const destroyed=Promise.withResolvers<void>(),session=await openPdfDocument(source().value),[page]=await session.index();
    pdf.destroy.mockReturnValue(destroyed.promise);
    const closing=session.close(),again=session.close();await vi.waitFor(()=>expect(pdf.destroy).toHaveBeenCalledOnce());
    expect(pdf.terminate).not.toHaveBeenCalled();
    await expect(session.materialize(page)).rejects.toMatchObject({name:'AbortError'});
    destroyed.resolve();await Promise.all([closing,again]);await session.close();
    expect(pdf.workerDestroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
  it('keeps cancellation connected until normal teardown has finished',async()=>{
    const controller=new AbortController(),session=await openPdfDocument(source().value,controller.signal);
    pdf.destroy.mockReturnValue(new Promise(()=>{}));
    const closing=session.close();await vi.waitFor(()=>expect(pdf.destroy).toHaveBeenCalledOnce());
    controller.abort();await closing;await session.close();
    expect(pdf.destroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
  it('closing an active session stops its page wait even without a caller signal',async()=>{
    const entered=Promise.withResolvers<void>(),session=await openPdfDocument(source().value),[page]=await session.index();
    pdf.getPage.mockImplementation(()=>{entered.resolve();return new Promise(()=>{});});pdf.destroy.mockReturnValue(new Promise(()=>{}));
    const reading=session.materialize(page),rejected=expect(reading).rejects.toMatchObject({name:'AbortError'});
    await entered.promise;await session.close();await rejected;
    expect(pdf.destroy).toHaveBeenCalledOnce();expect(pdf.terminate).toHaveBeenCalledOnce();
  });
});
