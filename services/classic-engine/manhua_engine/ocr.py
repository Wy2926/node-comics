"""Source-free PP-OCRv6 small/Korean routing with a MIT script/color probe."""
import hashlib
import json
from pathlib import Path
import unicodedata
import cv2
import numpy as np
import onnxruntime as ort
from .backend import Network
from .quality import text_strip
from .vendor.ocr import ctc_decode


def korean_script(text, confidence):
    letters=[c for c in text if c.isalpha()]
    hangul=sum('HANGUL' in unicodedata.name(c,'') for c in letters)
    return confidence>=.30 and hangul>=1 and hangul/max(1,len(letters))>=.25


def _read_raw(forward,rgb,quad):
    crop=text_strip(rgb,quad,pad=1.,sharp=0.)
    if crop is None or crop.shape[1]<4: return None
    text,prob,fg,bg=forward(crop);attempts=1
    if prob<.90:
        candidate=text_strip(rgb,quad,pad=3.,sharp=.4)
        if candidate is not None:
            other=forward(candidate);attempts+=1
            if other[1]>prob and len(other[0])>=max(1,len(text)*.65): text,prob,fg,bg=other
    return {'quad':quad.tolist(),'text':text,'prob':prob,'fg':fg,'bg':bg,'attempts':attempts}


class _PaddleRecognizer:
    def __init__(self,models,language,opts):
        from omegaconf import OmegaConf
        from rapidocr import EngineType
        from rapidocr.ch_ppocr_rec import TextRecognizer
        manifest=json.loads((Path(__file__).parent/'models.json').read_text(encoding='utf-8'))
        item=next(i for i in manifest['models'] if i.get('role')=='ocr' and i.get('language')==language)

        def verified(name):
            asset=next(i for i in manifest['models'] if i['name']==name)
            path=Path(models)/name
            if not path.is_file():
                raise FileNotFoundError(f'Run manhua download --ocr-language {language} first: {name}')
            with path.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=asset['sha256']:
                    raise ValueError(f'OCR model checksum mismatch: {path}')
            return path

        path=verified(item['name'])
        dictionary=verified(item['dictionary']) if item.get('dictionary') else None
        self.session=ort.InferenceSession(str(path),opts,providers=['CPUExecutionProvider'])
        if dictionary:
            self.alphabet=list(OmegaConf.load(dictionary).PostProcess.character_dict)
            if self.session.get_outputs()[0].shape[-1]!=len(self.alphabet)+2:
                raise ValueError('PP-OCR output does not match its character dictionary')
        else:
            self.alphabet=self.session.get_modelmeta().custom_metadata_map.get('character','').splitlines()
        if not self.alphabet: raise ValueError('PP-OCR model must contain its character dictionary')
        alphabet=self.alphabet

        class LocalTextRecognizer(TextRecognizer):
            def get_character_dict(self,cfg):
                # Supply verified local characters directly; never enter the
                # library's dictionary downloader. CTC adds blank/space itself.
                return list(alphabet),None

        cfg=OmegaConf.create({'engine_type':EngineType.ONNXRUNTIME,'session':self.session,
            'lang_type':{'ko':'korean','zh':'ch','auto':'ch'}.get(language,language),
            'rec_batch_num':1,'rec_img_shape':[3,48,320],'font_path':None},flags={'allow_objects':True})
        self.recognizer=LocalTextRecognizer(cfg)
        self.provider=f'RapidOCR-3.9.2-PP-OCR{"v6-small" if language=="auto" else "v5-"+language}-ORT-CPU-FP32'

    def forward(self,crop):
        from rapidocr.ch_ppocr_rec.typings import TextRecInput
        result=self.recognizer(TextRecInput(img=np.ascontiguousarray(crop[...,::-1])))
        return result.txts[0],float(result.scores[0]),(0,0,0),(255,255,255)


class Recognizer:
    def __init__(self,models,gpu,threads,language='ja'):
        if language not in ('auto','ja','zh','en','ko','latin'):
            raise ValueError(f'Unsupported OCR language: {language}')
        self.language=language
        opts=ort.SessionOptions();opts.intra_op_num_threads=1;opts.inter_op_num_threads=1
        opts.add_session_config_entry('session.intra_op.allow_spinning','0')
        if language=='auto':
            self.small=_PaddleRecognizer(models,'auto',opts)
            self.korean=_PaddleRecognizer(models,'ko',opts)
            self.probe=Recognizer(models,gpu,threads,'ja')
            self.alphabet=list(dict.fromkeys(self.small.alphabet+self.korean.alphabet))
            self.provider=f'Auto[{self.small.provider}+{self.korean.provider};script/color-probe={self.probe.provider}]'
        elif language=='ja':
            self.alphabet=(Path(__file__).parent/'alphabet.txt').read_text(encoding='utf-8').splitlines()
            path=Path(models)/'ocr-fp32/backbone.ncnn.param'
            if not path.is_file(): raise FileNotFoundError('Build FP32 OCR with tools/build_ocr.py first (see README)')
            self.net=Network(path,gpu,threads)
            self.net.lock_metric = 'ocr_lock_wait'
            self.session=ort.InferenceSession(str(path.parent/'decoder.onnx'),opts,providers=['CPUExecutionProvider'])
            self.provider=('NCNN-Vulkan' if gpu>=0 else 'NCNN-CPU')+'-FP32-backbone+ORT-CPU-FP32-decoder'
        else:
            self.paddle=_PaddleRecognizer(models,language,opts)
            self.alphabet=self.paddle.alphabet
            self.provider=self.paddle.provider

    def infer(self,crop):
        if self.language=='ja':
            # Match MIT CTC inference: black right context is essential for final characters.
            crop=cv2.copyMakeBorder(crop,0,0,0,135,cv2.BORDER_CONSTANT,value=0)
        x=np.ascontiguousarray((crop.astype(np.float32)/127.5-1).transpose(2,0,1))
        if self.language=='ja':
            if x.shape[-1]>8192: raise ValueError('OCR strip exceeds the model positional encoding limit')
            features=self.net.run({'in0':x},['out0'])[0]
            logits,colors=self.session.run(None,{'features':np.ascontiguousarray(features[:,0,:].T[None])})
        else: raise ValueError('Raw MIT logits are available only for --ocr-language ja')
        return logits[0],colors[0]

    def forward(self,crop):
        if self.language=='auto':
            text,prob,fg,bg=self.probe.forward(crop)
            model=self.korean if korean_script(text,prob) else self.small
            text,prob,_,_=model.forward(crop)
            return text,prob,fg,bg
        if self.language!='ja': return self.paddle.forward(crop)
        logits,colors=self.infer(crop)
        return ctc_decode(logits,self.alphabet,colors)

    def warmup(self):
        crop=np.full((48,128,3),255,np.uint8)
        for model in (self.probe,self.small,self.korean) if self.language=='auto' else (self,):
            model.forward(crop)

    def read(self,rgb,quad):
        if self.language=='auto':
            # Route using the raw probe, including text below the final .50
            # filter: weak MIT Korean can still reliably identify its script.
            probe=_read_raw(self.probe.forward,rgb,quad)
            if probe is None: return None
            model=self.korean if korean_script(probe['text'],probe['prob']) else self.small
            result=_read_raw(model.forward,rgb,quad)
            if result is not None:
                result.update(fg=probe['fg'],bg=probe['bg'],attempts=probe['attempts']+result['attempts'])
        else:
            result=_read_raw(self.forward,rgb,quad)
        if result is None or not result['text'].strip() or result['prob']<.50: return None
        return result
