"""Real-image CPU/Vulkan raw-output comparison; no translation/network calls."""
import argparse
import json
from pathlib import Path
import time
import numpy as np
from PIL import Image
from manhua_engine.backend import Network, detector_input, devices


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
    report['inpainting_backend']='LaMa DirectML is validated separately; this tool checks NCNN detection only'
    report['acceptance']={'db_mean_abs':1e-4,'seg_max_abs':.001}
    report['passed']=(report['db']['mean_abs']<1e-4 and report['seg']['max_abs']<.001)
    (out/f'{a.image.stem}-{a.size}-fp32.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2),flush=True)
    if not report['passed']: raise SystemExit(1)

if __name__=='__main__': main()
