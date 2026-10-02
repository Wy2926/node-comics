import type {RegionRect,RegionViewport} from './protocol';

export function validViewport(value:RegionViewport|undefined):value is RegionViewport {
  if(!value||![value.width,value.height,value.devicePixelRatio,value.scrollX,value.scrollY].every(Number.isFinite)
    ||value.width<1||value.height<1||value.devicePixelRatio<=0)return false;
  const visual=value.visualViewport;
  return !visual||[visual.width,visual.height,visual.offsetLeft,visual.offsetTop,visual.scale].every(Number.isFinite)
    &&visual.width>0&&visual.height>0&&visual.scale>0;
}
export function sameViewport(a:RegionViewport,b:RegionViewport):boolean {
  return validViewport(a)&&validViewport(b)&&a.width===b.width&&a.height===b.height
    &&a.devicePixelRatio===b.devicePixelRatio&&a.scrollX===b.scrollX&&a.scrollY===b.scrollY
    &&JSON.stringify(a.visualViewport)===JSON.stringify(b.visualViewport);
}
/** Inward rounding never sends a pixel outside the user's selected rectangle. */
export function cropGeometry(rect:RegionRect,viewport:RegionViewport,width:number,height:number) {
  if(!validViewport(viewport)||!rect||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)
    ||rect.x<0||rect.y<0||rect.width<1||rect.height<1||rect.x+rect.width>viewport.width||rect.y+rect.height>viewport.height
    ||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw Error('INVALID_REGION');
  // Desktop page zoom is reflected in the bitmap ratio. Pinch zoom is deliberately
  // rejected until its visual/layout viewport mapping is verified in each browser.
  const visual=viewport.visualViewport;
  if(visual&&(visual.scale!==1||visual.offsetLeft!==0||visual.offsetTop!==0))throw Error('INVALID_REGION');
  const sx=width/viewport.width,sy=height/viewport.height;
  const x=Math.ceil(rect.x*sx),y=Math.ceil(rect.y*sy);
  const right=Math.floor((rect.x+rect.width)*sx),bottom=Math.floor((rect.y+rect.height)*sy);
  if(right<=x||bottom<=y)throw Error('INVALID_REGION');
  return {pixels:{x,y,width:right-x,height:bottom-y},rect:{x:x/sx,y:y/sy,width:(right-x)/sx,height:(bottom-y)/sy}};
}
