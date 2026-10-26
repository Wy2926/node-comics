import {createHash} from 'node:crypto';
import type {Plugin} from 'vite';

// @gullabs/flipbook-core 3.2.2 (MPL-2.0). A small bottom-corner fold
// intersects the side and bottom, not the top. Keep its third vertex.
// Preferred-source patch and upstream archive are shipped in public/licenses.
const method=/getBottomClipArea\(\)\{[\s\S]*?(?=getAngle\(\))/g;
const methodSha256='29cda81e0c67ac846492609ce31846ca03146d533981036dcd86b43404f34219';
export function fixFlipbookClip(code:string):string{
 const matches=[...code.matchAll(method)],original=matches[0]?.[0];
 if(matches.length!==1||!original||createHash('sha256').update(original).digest('hex')!==methodSha256)throw Error('Flipbook crop method changed; review flipbook-clip.ts before upgrading.');
 return code.replace(original,original.replace('null!==this.sideIntersectPoint&&null!==this.topIntersectPoint?I(this.sideIntersectPoint,this.topIntersectPoint)>=10',
  'null!==this.sideIntersectPoint?(null===this.topIntersectPoint||I(this.sideIntersectPoint,this.topIntersectPoint)>=10)'));
}
export function flipbookClip():Plugin{
 return {name:'flipbook-small-fold-clip',enforce:'pre',transform(code,id){
  if(!id.split('?')[0].replaceAll('\\','/').endsWith('/@gullabs/flipbook-core/dist/index.js'))return;
  return {code:fixFlipbookClip(code),map:null};
 }};
}
