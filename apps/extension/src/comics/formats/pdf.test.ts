import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const pdf=vi.hoisted(()=>({options:undefined as unknown as {worker:{port:unknown};disableAutoFetch:boolean;disableStream:boolean;range:{requestDataRange(begin:number,end:number):void}},open:vi.fn(),getPage:vi.fn(),destroy:vi.fn(),workerDestroy:vi.fn(),workerStart:vi.fn(),terminate:vi.fn(),render:vi.fn(),cleanup:vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({PDFWorker:class{static create(options:{port:unknown}){return new this(options);}port:unknown;constructor({port}:{port:unknown}){this.port=port;}destroy=pdf.workerDestroy;},PDFDataRangeTransport:class{constructor(public length:number,public initial:Uint8Array){}onDataRange(){}},getDocument:(options:typeof pdf.options)=>{pdf.options=options;return {promise:pdf.open(),destroy:pdf.destroy};}}));
import {openPdfDocument} from './pdf';
import type {RandomAccessSource} from './contracts';
beforeEach(()=>{
  vi.clearAllMocks();vi.stubGlobal('location',{origin:'chrome-extension://fixture'});
  vi.stubGlobal('Worker',class{constructor(url:string,options:WorkerOptions){pdf.workerStart(url,options);}terminate=pdf.terminate;});
  pdf.open.mockResolvedValue({numPages:3,getPage:pdf.getPage});
  pdf.destroy.mockResolvedValue(undefined);pdf.render.mockImplementation(()=>({promise:Promise.resolve(),cancel:vi.fn()}));
  pdf.getPage.mockImplementation(async()=>({getViewport:({scale}:{scale:number})=>({width:300*scale,height:500*scale}),render:pdf.render,cleanup:pdf.cleanup}));
  vi.stubGlobal('document',{createElement:()=>({width:0,height:0,toBlob:(done:(blob:Blob)=>void)=>done(new Blob(['rendered'],{type:'image/png'}))})});
});
afterEach(()=>vi.unstubAllGlobals());
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
  it('preserves Safari runtime resource URLs and releases the dedicated worker on close or failure',async()=>{
    vi.stubGlobal('location',{origin:'safari-web-extension://lowercase'});
    vi.stubGlobal('chrome',{runtime:{getURL:(path:string)=>'safari-web-extension://UPPERCASE/'+path}});
    const session=await openPdfDocument(source().value);
    expect(pdf.workerStart).toHaveBeenCalledWith('safari-web-extension://UPPERCASE/import-assets/pdf/pdf.worker.mjs',{type:'module'});
    await session.close();expect(pdf.workerDestroy).toHaveBeenCalledTimes(1);expect(pdf.terminate).toHaveBeenCalledTimes(1);
    pdf.open.mockRejectedValue(new Error('invalid document'));
    await expect(openPdfDocument(source().value)).rejects.toThrow('invalid document');
    expect(pdf.workerDestroy).toHaveBeenCalledTimes(2);expect(pdf.terminate).toHaveBeenCalledTimes(2);
  });
  it('stops an excessive range request instead of falling back to the complete source',async()=>{
    const {value,readAt}=source(),session=await openPdfDocument(value);
    try{pdf.options.range.requestDataRange(0,17*1024*1024);expect(pdf.destroy).toHaveBeenCalledOnce();expect(readAt).toHaveBeenCalledTimes(1);}
    finally{await session.close();}
  });
  it('renders large pages at 144 dpi without the former pixel and edge ceilings',async()=>{
    pdf.getPage.mockImplementation(async()=>({getViewport:({scale}:{scale:number})=>({width:5000*scale,height:6000*scale}),render:pdf.render,cleanup:pdf.cleanup}));
    const canvas={width:0,height:0,toBlob:(done:(blob:Blob)=>void)=>{expect([canvas.width,canvas.height]).toEqual([10000,12000]);done(new Blob(['rendered'],{type:'image/png'}));}};
    vi.stubGlobal('document',{createElement:()=>canvas});
    const session=await openPdfDocument(source().value);
    try { const [page]=await session.index();expect((await session.materialize(page)).type).toBe('image/png'); }
    finally { await session.close(); }
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
  it('preserves cancellation and resource-limit failures instead of rewriting them',async()=>{
    for(const failure of [new DOMException('user cancelled','AbortError'),new Error('PDF 本次目录或页面准备超过读取预算，请拆分文件。')]){
      pdf.open.mockRejectedValue(failure);await expect(openPdfDocument(source().value)).rejects.toBe(failure);
    }
  });
});
