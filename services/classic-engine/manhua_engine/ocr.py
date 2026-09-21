"""MIT multilingual manga OCR and optional PP-OCRv5 specialist recognition."""
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
from .backend import Network
from .quality import text_strip
from .vendor.ocr import ctc_decode


class Recognizer:
    def __init__(self,models,gpu,threads,language='ja'):
        if language not in ('auto','ja','zh','en','ko','latin'):
            raise ValueError(f'Unsupported OCR language: {language}')
        self.language=language
        opts=ort.SessionOptions();opts.intra_op_num_threads=1;opts.inter_op_num_threads=1
        opts.add_session_config_entry('session.intra_op.allow_spinning','0')
        if language in ('auto','ja'):
            self.alphabet=(Path(__file__).parent/'alphabet.txt').read_text(encoding='utf-8').splitlines()
            path=Path(models)/'ocr-fp32/backbone.ncnn.param'
            if not path.is_file(): raise FileNotFoundError('Build FP32 OCR with tools/build_ocr.py first (see README)')
            self.net=Network(path,gpu,threads)
            self.session=ort.InferenceSession(str(path.parent/'decoder.onnx'),opts,providers=['CPUExecutionProvider'])
            self.provider=('NCNN-Vulkan' if gpu>=0 else 'NCNN-CPU')+'-FP32-backbone+ORT-CPU-FP32-decoder'
        else:
            # Use RapidOCR's own normalization and decoder with a supplied ORT
            # session. Reject missing assets/metadata before its download paths.
            from omegaconf import OmegaConf
            from rapidocr import EngineType
            from rapidocr.ch_ppocr_rec import TextRecognizer
            manifest=json.loads((Path(__file__).parent/'models.json').read_text(encoding='utf-8'))
            item=next(i for i in manifest['models'] if i.get('language')==language)
            path=Path(models)/item['name']
            if not path.is_file():
                raise FileNotFoundError(f'Run manhua download --ocr-language {language} first')
            with path.open('rb') as f:
                if hashlib.file_digest(f,'sha256').hexdigest()!=item['sha256']:
                    raise ValueError(f'OCR model checksum mismatch: {path}')
            self.session=ort.InferenceSession(str(path),opts,providers=['CPUExecutionProvider'])
            self.alphabet=self.session.get_modelmeta().custom_metadata_map.get('character','').splitlines()
            if not self.alphabet: raise ValueError('PP-OCR model must contain its character dictionary')
            cfg=OmegaConf.create({'engine_type':EngineType.ONNXRUNTIME,'session':self.session,
                'lang_type':{'ko':'korean','zh':'ch'}.get(language,language),
                'rec_batch_num':1,'rec_img_shape':[3,48,320],'font_path':None},flags={'allow_objects':True})
            self.recognizer=TextRecognizer(cfg)
            self.provider=f'RapidOCR-3.9.2-PP-OCRv5-{language}-ORT-CPU-FP32'

    def infer(self,crop):
        if self.language in ('auto','ja'):
            # Match MIT CTC inference: black right context is essential for final characters.
            crop=cv2.copyMakeBorder(crop,0,0,0,135,cv2.BORDER_CONSTANT,value=0)
        x=np.ascontiguousarray((crop.astype(np.float32)/127.5-1).transpose(2,0,1))
        if self.language in ('auto','ja'):
            if x.shape[-1]>8192: raise ValueError('OCR strip exceeds the model positional encoding limit')
            features=self.net.run({'in0':x},['out0'])[0]
            logits,colors=self.session.run(None,{'features':np.ascontiguousarray(features[:,0,:].T[None])})
        else: raise ValueError('Raw MIT logits are available only for --ocr-language ja')
        return logits[0],colors[0]

    def forward(self,crop):
        if self.language not in ('auto','ja'):
            from rapidocr.ch_ppocr_rec.typings import TextRecInput
            result=self.recognizer(TextRecInput(img=np.ascontiguousarray(crop[...,::-1])))
            return result.txts[0],float(result.scores[0]),(0,0,0),(255,255,255)
        logits,colors=self.infer(crop)
        return ctc_decode(logits,self.alphabet,colors)

    def warmup(self): self.forward(np.full((48,128,3),255,np.uint8))

    def read(self,rgb,quad):
        crop=text_strip(rgb,quad,pad=1.,sharp=0.)
        if crop is None or crop.shape[1]<4: return None
        text,prob,fg,bg=self.forward(crop);attempts=1
        if prob<.90:
            candidate=text_strip(rgb,quad,pad=3.,sharp=.4)
            if candidate is not None:
                other=self.forward(candidate);attempts+=1
                if other[1]>prob and len(other[0])>=max(1,len(text)*.65): text,prob,fg,bg=other
        if not text.strip() or prob<.60: return None
        return {'quad':quad.tolist(),'text':text,'prob':prob,'fg':fg,'bg':bg,'attempts':attempts}
