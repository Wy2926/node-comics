from concurrent.futures import ThreadPoolExecutor, wait
from collections import Counter
from pathlib import Path
import time
import cv2
import numpy as np
from PIL import Image
from .backend import Network, detector_input, detector_output, aot_input
from .vendor.grouping import Quadrilateral, merge_bboxes_text_region
from .translation import atomic_json
from .ocr import Recognizer
from .quality import conservative_mask, repair_page, detection_windows, unique_quads
from .layout import draw_region, resolve_colors, font_paths, coverage
from .languages import join_lines
from .bubbles import lettering_areas


def group(lines,w,h,language='ja'):
    quads=[Quadrilateral(np.array(r['quad']),r['text'],r['prob'],tuple(r['fg']),tuple(r['bg'])) for r in lines]
    regions=[]
    for members,fg,bg in merge_bboxes_text_region(quads,w,h):
        pts=np.concatenate([t.pts for t in members])
        direction=Counter(t.direction for t in members).most_common(1)[0][0]
        angle=float(np.degrees(np.mean([t.angle for t in members]))-90)
        if abs(angle)<3: angle=0.
        cx,cy=pts.mean(0);rad=np.radians(angle)
        dx,dy=pts[:,0]-cx,pts[:,1]-cy
        rx,ry=np.cos(rad)*dx+np.sin(rad)*dy,-np.sin(rad)*dx+np.cos(rad)*dy
        regions.append({'text':join_lines([t.text for t in members],language),'dir':direction,
            'bbox':[int(pts[:,0].min()),int(pts[:,1].min()),int(pts[:,0].max()),int(pts[:,1].max())],
            'quads':[t.pts.tolist() for t in members],'fg':list(map(int,fg)),'bg':list(map(int,bg)),
            'angle':angle,'cx':float(cx),'cy':float(cy),'boxW':float(np.ptp(rx)),'boxH':float(np.ptp(ry))})
    # Japanese pages read right-to-left; Korean/English use left-to-right.
    regions.sort(key=lambda r:(r['bbox'][1]//150,-r['bbox'][2] if language=='ja' else r['bbox'][0],r['bbox'][1]))
    return regions


class Engine:
    def __init__(self,models='models',gpu=0,ocr_workers=8,threads=2,tile=768,font=None,png_compression=1,detect_size=1280,ocr_language='ja',direction='auto'):
        self.tile=tile
        self.detect_size=detect_size
        self.font=(str(font),) if isinstance(font,(str,Path)) else tuple(font or ())
        font_paths(self.font)
        self.direction=direction
        self.png_compression=png_compression
        cv2.setNumThreads(1)
        models=Path(models)
        self.detector=Network(models/'dbnet_detect.ncnn.param',gpu,threads)
        self.inpainter=Network(models/'mit_aot_fixed512.ncnn.param',gpu,threads)
        self.ocr=Recognizer(models,gpu,threads,ocr_language)
        self.alphabet=self.ocr.alphabet
        self.ocr_pool=ThreadPoolExecutor(ocr_workers,thread_name_prefix='ocr')
        self.removal_pool=ThreadPoolExecutor(1,thread_name_prefix='inpaint')

    def close(self):
        self.ocr_pool.shutdown(wait=True);self.removal_pool.shutdown(wait=True)

    def warmup(self):
        for path in font_paths(self.font): coverage(path)
        rgb=np.full((1024,720,3),255,np.uint8)
        self.detect(rgb)
        self.inpainter.run(aot_input(rgb,np.zeros(rgb.shape[:2],np.uint8),self.tile),['out0'])
        self.ocr.warmup()

    def detect(self,rgb):
        quads=[]; mask=np.zeros(rgb.shape[:2],np.uint8)
        windows=detection_windows(*rgb.shape[:2])
        for x0,y0,x1,y1 in windows:
            crop=rgb[y0:y1,x0:x1]
            x,ratio=detector_input(crop,self.detect_size)
            db,seg=self.detector.run({'in0':x},['out0','out1'])
            local,seg=detector_output(db,seg,crop.shape,x.shape,ratio)
            quads.extend(q+np.array([x0,y0],np.float32) for q in local)
            mask[y0:y1,x0:x1]=np.maximum(mask[y0:y1,x0:x1],seg)
        return (unique_quads(quads) if len(windows)>1 else quads),mask

    def read_line(self,rgb,quad):
        return self.ocr.read(rgb,quad)

    def remove(self,rgb,mask):
        start=time.perf_counter()
        if not mask.any(): return rgb.copy(),0.
        cleaned,_=repair_page(self.inpainter,rgb,mask,self.tile)
        return cleaned,time.perf_counter()-start

    def page(self,path,translator,outdir):
        start=time.perf_counter();timings={}
        def mark(name,t): timings[name]=time.perf_counter()-t
        path=Path(path);outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
        t=time.perf_counter();rgb=np.array(Image.open(path).convert('RGB'));mark('decode',t)
        t=time.perf_counter();quads,seg=self.detect(rgb);mark('detect',t)
        t=time.perf_counter()
        futures=[self.ocr_pool.submit(self.read_line,rgb,q) for q in quads]
        try:
            lines=[r for f in futures if (r:=f.result()) is not None]
        except Exception:
            wait(futures)
            raise
        mark('ocr',t)
        t=time.perf_counter();regions=group(lines,rgb.shape[1],rgb.shape[0],self.ocr.language)
        mask=conservative_mask(regions,seg)
        mark('group_mask',t)
        removal=self.removal_pool.submit(self.remove,rgb,mask)
        t=time.perf_counter()
        try:
            translated=translator.translate([r['text'] for r in regions])
            if len(translated)!=len(regions): raise ValueError('Translation count differs from region count')
        except Exception:
            # Drain this page before admitting more work, even on cache/API failures.
            removal.result()
            raise
        mark('translate',t)
        cleaned,timings['inpaint']=removal.result()
        t=time.perf_counter();image=Image.fromarray(cleaned)
        areas=lettering_areas(cleaned,regions)
        for region,text,area in zip(regions,translated,areas):
            region['translation']=text
            fg,bg=resolve_colors(cleaned,region['bbox'])
            region['layout']=draw_region(image,text,region,self.font,fg,bg,target=translator.target,direction=self.direction,area=area)
        mark('render',t)
        t=time.perf_counter();image.save(outdir/f'{path.stem}.png',compress_level=self.png_compression);mark('write',t)
        timings['total']=time.perf_counter()-start
        record={'page':path.name,'size':[rgb.shape[1],rgb.shape[0]],'detected_lines':len(quads),
                'detection_quads':[q.tolist() for q in quads],
                'recognized_lines':len(lines),'regions':regions,'timings':timings,'lines':lines,
                'mask_pixels':int(np.count_nonzero(mask)),'ocr_attempts':sum(r.get('attempts',1) for r in lines)}
        atomic_json(outdir/f'{path.stem}.json',record)
        return {k:v for k,v in record.items() if k not in ('regions','lines','detection_quads')}|{'region_count':len(regions)}
