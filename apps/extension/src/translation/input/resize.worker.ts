import {resizeInput} from './resize';

self.onmessage=async(event:MessageEvent<{blob:Blob;width:number;height:number}>)=>{
  try {self.postMessage(await resizeInput(event.data.blob,event.data.width,event.data.height));}
  catch {self.postMessage({error:true});}
};
