export function safeImageUrl(input:string,base:string):string|null {try {if(!input.trim())return null;const u=new URL(input,base);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
export const isPageImageUrl=(url:string)=>/^page-image:[a-zA-Z0-9-]+$/.test(url);
