import type {ComicPage} from './comic-shared';
import RarWorker from './rar.worker?worker';
export async function openRar(file:File) {
  const worker=new RarWorker();
  function request<T>(value:object):Promise<T> {
    return new Promise((resolve,reject)=>{
      const fail=(message:string)=>{clearTimeout(timer);worker.terminate();reject(Error(message));};
      const timer=setTimeout(()=>fail('RAR 解析超过 60 秒，请拆分或转换为 ZIP 后重试。'),60000);
      worker.onerror=()=>fail('RAR 解码器无法运行，请重新打开阅读器或转换为 ZIP。');
      worker.onmessage=(event:MessageEvent<T&{error?:string}>)=>{
        clearTimeout(timer);
        if(event.data.error)fail(event.data.error);else resolve(event.data);
      };
      worker.postMessage(value);
    });
  }
  try {
    const {total}=await request<{total:number}>({file});
    return {total,close:()=>worker.terminate(),pages:(async function*():AsyncGenerator<ComicPage> {
      while(true) {
        const next=await request<IteratorResult<ComicPage>>({});
        if(next.done)return;
        yield next.value;
      }
    })()};
  } catch(error) {worker.terminate();throw error;}
}
