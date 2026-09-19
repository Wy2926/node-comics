"""Real-image CPU/Vulkan raw-output comparison; no translation/network calls."""
import argparse
import json
from pathlib import Path
import time
import cv2
import numpy as np
from PIL import Image
from manhua_engine.backend import Network, detector_input, detector_output, aot_input, composite, devices


def main():
    p=argparse.ArgumentParser()
    p.add_argument('image', type=Path)
    p.add_argument('--size',type=int,default=768)
    a=p.parse_args()
    out=Path('artifacts/parity');out.mkdir(parents=True,exist_ok=True)
    rgb=np.array(Image.open(a.image).convert('RGB'))
    x,ratio=detector_input(rgb)
    report={'devices':devices(),'image':a.image.name,'precision':'fp32','size':a.size}
    results={}
    for gpu in [-1,0]:
        net=Network('models/dbnet_detect.ncnn.param',gpu,4)
        t=time.perf_counter(); db,seg=net.run({'in0':x},['out0','out1'])
        report[f'detect_{gpu}_s']=time.perf_counter()-t
        results[gpu]=(db,seg)
        del net
    for idx,name in enumerate(['db','seg']):
        delta=np.abs(results[-1][idx]-results[0][idx])
        report[name]={'max_abs':float(delta.max()),'mean_abs':float(delta.mean())}
    quads,mask=detector_output(*results[-1],rgb.shape,x.shape,ratio)
    mask=cv2.dilate(mask,np.ones((25,25),np.uint8))
    inputs=aot_input(rgb,mask,a.size)
    outputs={}
    for gpu in [-1,0]:
        net=Network('models/mit_aot_fixed512.ncnn.param',gpu,4)
        t=time.perf_counter(); result=net.run(inputs,['out0'])[0]
        report[f'aot_{gpu}_s']=time.perf_counter()-t
        outputs[gpu]=result
        Image.fromarray(composite(rgb,mask,result)).save(out/f'{a.image.stem}-{a.size}-fp32-{gpu}.png')
        del net
    delta=np.abs(outputs[-1]-outputs[0])
    report['aot']={'max_abs':float(delta.max()),'mean_abs':float(delta.mean()),
                   'p99_abs':float(np.quantile(delta,.99))}
    report['acceptance']={'db_mean_abs':1e-4,'seg_max_abs':.001,'aot_max_abs':.005,'aot_mean_abs':.0001}
    report['passed']=(report['db']['mean_abs']<1e-4 and report['seg']['max_abs']<.001
                      and report['aot']['max_abs']<.005 and report['aot']['mean_abs']<.0001)
    (out/f'{a.image.stem}-{a.size}-fp32.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2),flush=True)
    if not report['passed']: raise SystemExit(1)

if __name__=='__main__': main()
