"""Geometry-preserving crops and conservative, region-local text removal."""
import cv2
import numpy as np
from .vendor.ocr import sort_pnts


def detection_windows(height,width):
    """Overlapping strips retain text resolution on webtoons and wide spreads."""
    if max(height,width)<=2.5*min(height,width): return [(0,0,width,height)]
    vertical=height>width
    length=max(height,width); extent=max(256,2*min(height,width))
    overlap=max(64,extent//4); step=extent-overlap
    starts=list(range(0,max(1,length-extent+1),step))
    if starts[-1]+extent<length: starts.append(max(0,length-extent))
    return [(0,start,width,min(length,start+extent)) if vertical else
            (start,0,min(length,start+extent),height) for start in starts]


def unique_quads(quads):
    """Suppress overlap-window duplicates, preferring complete larger boxes."""
    kept=[]
    for q in sorted((np.asarray(q,np.float32) for q in quads),key=cv2.contourArea,reverse=True):
        area=cv2.contourArea(q)
        if area<=0: continue
        if any(cv2.intersectConvexConvex(q,k)[0]>.65*min(area,cv2.contourArea(k)) for k in kept): continue
        kept.append(q)
    return kept


def text_strip(rgb,quad,pad=1.,sharp=0.):
    center,(w,h),angle=cv2.minAreaRect(np.asarray(quad,np.float32))
    points,vertical=sort_pnts(cv2.boxPoints((center,(w+2*pad,h+2*pad),angle)))
    points=points.astype(np.float32)
    width=(np.linalg.norm(points[1]-points[0])+np.linalg.norm(points[2]-points[3]))/2
    height=(np.linalg.norm(points[3]-points[0])+np.linalg.norm(points[2]-points[1]))/2
    if min(width,height)<1: return None
    if vertical: ow,oh=48,max(4,round(48*height/width))
    else: ow,oh=max(4,round(48*width/height)),48
    if max(ow,oh)>8056: raise ValueError('OCR strip exceeds 8056 pixels; split this unusually long text line')
    dest=np.array([[0,0],[ow-1,0],[ow-1,oh-1],[0,oh-1]],np.float32)
    matrix=cv2.getPerspectiveTransform(points,dest)
    crop=cv2.warpPerspective(rgb,matrix,(ow,oh),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_REPLICATE)
    if vertical: crop=cv2.rotate(crop,cv2.ROTATE_90_COUNTERCLOCKWISE)
    if sharp: crop=cv2.addWeighted(crop,1+sharp,cv2.GaussianBlur(crop,(0,0),1.2),-sharp,0)
    return crop


def conservative_mask(regions,seg):
    result=np.zeros_like(seg)
    h,w=seg.shape
    for region in regions:
        for quad in region['quads']:
            center,(qw,qh),angle=cv2.minAreaRect(np.asarray(quad,np.float32))
            radius=int(np.clip(round(min(qw,qh)*.10),2,5))
            points=cv2.boxPoints((center,(qw+radius*4,qh+radius*4),angle)).astype(np.int32)
            x,y,bw,bh=cv2.boundingRect(points)
            x0,y0=max(0,x-radius),max(0,y-radius)
            x1,y1=min(w,x+bw+radius),min(h,y+bh+radius)
            if x1<=x0 or y1<=y0: continue
            allow=np.zeros((y1-y0,x1-x0),np.uint8)
            cv2.fillPoly(allow,[points-[x0,y0]],255)
            local=cv2.bitwise_and(seg[y0:y1,x0:x1],allow)
            local=cv2.dilate(local,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(radius*2+1,)*2))
            result[y0:y1,x0:x1]=np.maximum(result[y0:y1,x0:x1],local)
    return result


def repair_windows(mask,context=48):
    h,w=mask.shape
    count,_,stats,_=cv2.connectedComponentsWithStats((mask>0).astype(np.uint8),8)
    boxes=[[max(0,x-context),max(0,y-context),min(w,x+bw+context),min(h,y+bh+context)]
           for x,y,bw,bh,area in stats[1:] if area>0]
    # Merge overlapping context windows to avoid repetitive repairs and seams.
    merged=[]
    for box in boxes:
        changed=True
        while changed:
            changed=False
            for i,other in enumerate(merged):
                if box[0]<other[2] and other[0]<box[2] and box[1]<other[3] and other[1]<box[3]:
                    box=[min(box[0],other[0]),min(box[1],other[1]),max(box[2],other[2]),max(box[3],other[3])]
                    merged.pop(i);changed=True;break
        merged.append(box)
    return merged


def repair_region(net,rgb,mask,tile):
    h,w=rgb.shape[:2]
    tile=min(tile,getattr(net,'input_size',tile))
    scale=min(tile/max(h,w),1.)
    nh,nw=max(1,round(h*scale)),max(1,round(w*scale))
    small=cv2.resize(rgb,(nw,nh),interpolation=cv2.INTER_CUBIC if scale>1 else cv2.INTER_AREA)
    m=cv2.resize(mask,(nw,nh),interpolation=cv2.INTER_NEAREST)
    # Preserve geometry; mirror the mask with the image at padding boundaries.
    bottom,right=(-nh)%8,(-nw)%8
    canvas=cv2.copyMakeBorder(small,0,bottom,0,right,cv2.BORDER_REFLECT_101)
    padded=cv2.copyMakeBorder(m,0,bottom,0,right,cv2.BORDER_REFLECT_101)
    restored=net.predict(canvas,padded)
    restored=cv2.resize(restored[:nh,:nw],(w,h),interpolation=cv2.INTER_CUBIC)
    return np.where((mask>0)[...,None],np.clip(restored,0,255).astype(np.uint8),rgb)


def repair_page(net,rgb,mask,tile=768):
    result=rgb.copy()
    windows=repair_windows(mask)
    for x0,y0,x1,y1 in windows:
        result[y0:y1,x0:x1]=repair_region(net,rgb[y0:y1,x0:x1],mask[y0:y1,x0:x1],tile)
    return result,len(windows)
