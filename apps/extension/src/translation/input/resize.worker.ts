import {ImageOutputTooLargeError,resizeInput} from './resize';
import type {InputProfile} from './limits';

self.onmessage=async(event:MessageEvent<{blob:Blob;width:number;height:number;profile?:InputProfile}>)=>{
  try {self.postMessage(await resizeInput(event.data.blob,event.data.width,event.data.height,event.data.profile));}
  catch(error){self.postMessage({error:error instanceof ImageOutputTooLargeError?error.code:'IMAGE_INVALID'});}
};
