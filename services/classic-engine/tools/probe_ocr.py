"""Compare actual OCR strips to original FP32 ONNX and check mixed-width repeats."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image
from manhua_engine.engine import Engine
from manhua_engine.ocr import Recognizer
from manhua_engine.quality import text_strip
from manhua_engine.vendor.ocr import ctc_decode


def main():
    p=argparse.ArgumentParser();p.add_argument('input',type=Path)
    p.add_argument('--repeats',type=int,default=2);p.add_argument('--limit',type=int)
    p.add_argument('--output',type=Path,default=Path('artifacts/ocr-probe'))
    a=p.parse_args()
    paths=sorted(a.input.glob('*.webp')) if a.input.is_dir() else [a.input]
    engine=Engine();crops=[]
    for path in paths:
        rgb=np.array(Image.open(path).convert('RGB'));quads,_=engine.detect(rgb)
        for q in quads:
            crop=text_strip(rgb,q)
            if crop is not None: crops.append((path.name,crop))
    engine.close()
    if a.limit:crops=crops[:a.limit]
    gpu=Recognizer('models',0,2)
    opt=ort.SessionOptions();opt.intra_op_num_threads=1
    opt.add_session_config_entry('session.intra_op.allow_spinning','0')
    ref=ort.InferenceSession('models/ocr-fp32/ocr.onnx',opt,providers=['CPUExecutionProvider'])
    rows=[]
    for i,(name,crop) in enumerate(crops):
        padded=cv2.copyMakeBorder(crop,0,0,0,135,cv2.BORDER_CONSTANT,value=0)
        x=np.ascontiguousarray((padded.astype(np.float32)/127.5-1).transpose(2,0,1)[None])
        t=time.perf_counter();reference=ref.run(None,{'image':x});ref_s=time.perf_counter()-t
        t=time.perf_counter();logits,colors=gpu.infer(crop);gpu_s=time.perf_counter()-t
        error=np.abs(logits-reference[0][0]);color_error=np.abs(colors-reference[1][0])
        expected=ctc_decode(reference[0][0],gpu.alphabet)[0]
        actual=ctc_decode(logits,gpu.alphabet)[0]
        rows.append({'page':name,'width':crop.shape[1],'reference_s':ref_s,'hybrid_s':gpu_s,
                     'max_abs':float(error.max()),'mean_abs':float(error.mean()),
                     'color_max_abs':float(color_error.max()),'text_equal':actual==expected,
                     'expected':expected,'actual':actual,'repeat_equal':True,
                     'sha256':hashlib.sha256(logits.tobytes()+colors.tobytes()).hexdigest()})
        if i%50==0:print(f'Validated {i+1}/{len(crops)}',flush=True)
    for repeat in range(a.repeats):
        for row,(_,crop) in zip(rows,crops):
            logits,colors=gpu.infer(crop)
            row['repeat_equal'] &= hashlib.sha256(logits.tobytes()+colors.tobytes()).hexdigest()==row['sha256']
        print(f'Repeat {repeat+1} complete',flush=True)
    report={'strips':len(rows),'repeats':a.repeats,'text_equal':sum(r['text_equal'] for r in rows),
            'repeat_equal':sum(r['repeat_equal'] for r in rows),'max_abs':max(r['max_abs'] for r in rows),
            'color_max_abs':max(r['color_max_abs'] for r in rows),
            'median_reference_ms':float(np.median([r['reference_s'] for r in rows])*1000),
            'median_hybrid_ms':float(np.median([r['hybrid_s'] for r in rows])*1000),'rows':rows}
    out=a.output;out.mkdir(parents=True,exist_ok=True)
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},indent=2))
    if report['text_equal']!=len(rows) or report['repeat_equal']!=len(rows):raise SystemExit(1)

if __name__=='__main__':main()
