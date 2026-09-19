"""Check real-page edit bounds and adaptive AOT CPU/Vulkan agreement."""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image
from manhua_engine.engine import Engine
from manhua_engine.backend import Network
from manhua_engine.quality import conservative_mask, repair_page


def main():
    p=argparse.ArgumentParser();p.add_argument('input',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--reference-pages',nargs='*',default=['00015','00025'])
    a=p.parse_args();engine=Engine();cpu=Network('models/mit_aot_fixed512.ncnn.param',-1,4);rows=[]
    for path in sorted(a.input.glob('*.webp')):
        record=json.loads((a.output/(path.stem+'.json')).read_text(encoding='utf-8'))
        rgb=np.array(Image.open(path).convert('RGB'));_,seg=engine.detect(rgb)
        mask=conservative_mask(record['regions'],seg);allowed=mask>0
        for region in record['regions']:
            if region['layout'].get('rendered'):
                x0,y0,x1,y1=region['layout']['bounds']
                if not (0<=x0<x1<=rgb.shape[1] and 0<=y0<y1<=rgb.shape[0]):raise AssertionError('Layout outside page')
                allowed[y0:y1,x0:x1]=True
        output=np.array(Image.open(a.output/(path.stem+'.png')).convert('RGB'))
        row={'page':path.name,'outside_changed_pixels':int(np.count_nonzero(np.any(rgb!=output,axis=-1)&~allowed))}
        if path.stem in a.reference_pages:
            gpu_image,n=repair_page(engine.inpainter,rgb,mask)
            cpu_image,_=repair_page(cpu,rgb,mask)
            error=np.abs(gpu_image.astype(np.int16)-cpu_image.astype(np.int16))
            row.update({'repair_windows':n,'aot_pixel_max_abs':int(error.max()),'aot_pixel_mean_abs':float(error.mean()),
                        'inpaint_outside_changed_pixels':int(np.count_nonzero(np.any(gpu_image!=rgb,axis=-1)&(mask==0)))})
        rows.append(row)
    engine.close()
    passed=all(r['outside_changed_pixels']==0 and r.get('inpaint_outside_changed_pixels',0)==0
               and r.get('aot_pixel_max_abs',0)<=1 for r in rows)
    report={'passed':passed,'pages':len(rows),'rows':rows}
    (a.output/'integrity.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))
    if not passed:raise SystemExit(1)

if __name__=='__main__':main()
