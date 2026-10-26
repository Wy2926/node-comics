// A transition can briefly share displayed pixels after their React owner unmounts.
// Retaining a URL does not read, decode, or copy the underlying image again.
const references=new Map<string,number>();
// Only live turn previews publish here; committed pictures still acquire their
// own authorized source lease before borrowing the same display URL.
const shared=new Map<string,string>();
export function shareReaderImageURL(id:string,url:string){
 shared.set(id,url);
 return ()=>{if(shared.get(id)===url)shared.delete(id);};
}
export function borrowReaderImageURL(id:string){
 const url=shared.get(id),count=url?references.get(url):undefined;
 if(!url||count===undefined)return;
 references.set(url,count+1);return url;
}
export function createReaderImageURL(blob:Blob){
 const url=URL.createObjectURL(blob);references.set(url,1);return url;
}
export function releaseReaderImageURL(url:string){
 const count=references.get(url);if(count===undefined)return;
 if(count>1)references.set(url,count-1);
 else{references.delete(url);URL.revokeObjectURL(url);}
}
export function retainReaderImageURL(url:string){
 const count=references.get(url);if(count===undefined)return ()=>{};
 references.set(url,count+1);let released=false;
 return ()=>{if(!released){released=true;releaseReaderImageURL(url);}};
}
