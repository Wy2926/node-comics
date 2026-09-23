import type {SourceImageAdapter} from '../contracts/image';
const sites=import.meta.glob<SourceImageAdapter>('../sites/*/image.ts', {eager:true, import:'image'});
export const sourceImages:Readonly<Record<string,SourceImageAdapter>>=Object.fromEntries(
  Object.entries(sites).map(([path,image])=>[path.split('/').at(-2)!,image]),
);
