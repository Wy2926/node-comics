"""Export the original CTC checkpoint to FP32 ONNX and NCNN (build-time only)."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import shutil
import tempfile
import types
import zipfile

import torch
import pnnx

URL='https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/ocr-ctc.zip'
SHA='fc61c52f7a811bc72c54f6be85df814c6b60f63585175db27cb94a08e0c30101'
REVISION='d5a3eee4a7b7b7754b71baa2ee82309dfff468bc'
SOURCE_SHA='4f068e45b2bec8741219a30d1784a30aa058a0bd3058d4247da85f3ab7caf530'


def load_model(source,checkpoint,alphabet):
    for name in ['manga_translator','manga_translator.ocr','manga_translator.utils']:
        mod=types.ModuleType(name);mod.__path__=[];sys.modules[name]=mod
    for name,attr in [('manga_translator.config','OcrConfig'),('manga_translator.ocr.common','OfflineOCR')]:
        mod=types.ModuleType(name);setattr(mod,attr,object);sys.modules[name]=mod
    utils=sys.modules['manga_translator.utils']
    for name in ['TextBlock','Quadrilateral','AvgMeter','chunks']: setattr(utils,name,object)
    bubble=types.ModuleType('manga_translator.utils.bubble');bubble.is_ignore=lambda *a:False
    sys.modules[bubble.__name__]=bubble
    name='manga_translator.ocr.model_48px_ctc'
    spec=importlib.util.spec_from_file_location(name,source)
    mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod)
    model=mod.OCR(alphabet,768)
    weights=torch.load(checkpoint,map_location='cpu',weights_only=True)
    weights=weights.get('model',weights)
    for key in list(weights):
        if key.endswith('.pe.pe'): weights.pop(key)
    result=model.load_state_dict(weights,strict=False)
    if result.unexpected_keys or any(not k.endswith('.pe.pe') for k in result.missing_keys):
        raise RuntimeError(str(result))
    return model.eval()


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source-file',type=Path,required=True)
    p.add_argument('--archive',type=Path,required=True)
    p.add_argument('--work',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    if hashlib.sha256(a.source_file.read_bytes()).hexdigest()!=SOURCE_SHA: raise RuntimeError('OCR source checksum mismatch')
    cache=a.work;cache.mkdir(parents=True,exist_ok=True)
    archive=a.archive
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=SHA: raise RuntimeError('Checkpoint checksum mismatch')
    with zipfile.ZipFile(archive) as z:
        for name in ['ocr-ctc.ckpt','alphabet-all-v5.txt']:
            entry=next(n for n in z.namelist() if Path(n).name==name)
            (cache/name).write_bytes(z.read(entry))
    alphabet=(cache/'alphabet-all-v5.txt').read_text(encoding='utf-8').splitlines()
    if alphabet!=(Path(__file__).resolve().parents[1]/'manhua_engine/alphabet.txt').read_text(encoding='utf-8').splitlines():
        raise RuntimeError('Checkpoint alphabet differs from the runtime alphabet')
    model=load_model(a.source_file,cache/'ocr-ctc.ckpt',alphabet)
    torch.set_num_threads(4);torch.manual_seed(1)
    torch.backends.mha.set_fastpath_enabled(False)
    x=torch.zeros(1,3,48,256)
    class Decoder(torch.nn.Module):
        def __init__(self,model):
            super().__init__();self.model=model
        def forward(self,features):
            feats=self.model.encoders(features)
            return self.model.char_pred(self.model.char_pred_norm(feats)),self.model.color_pred1(feats)
    with tempfile.TemporaryDirectory(prefix='export-',dir=cache) as temporary:
        backbone=Path(temporary)/'backbone.pt'
        torch.jit.trace(model.backbone,x,check_trace=False).save(str(backbone))
        pnnx.convert(backbone.resolve().as_posix(),inputs=[x],inputs2=[torch.zeros(1,3,48,512)],fp16=False,device='cpu')
        for name in ('backbone.ncnn.param','backbone.ncnn.bin'):
            shutil.copyfile(backbone.parent/name,a.output/name)
    features=model.backbone(x).squeeze(2).permute(0,2,1)
    torch.onnx.export(Decoder(model).eval(),features,str(a.output/'decoder.onnx'),input_names=['features'],
                      output_names=['char_logits','color'],dynamic_axes={'features':{0:'N',1:'T'},
                      'char_logits':{0:'N',1:'T'},'color':{0:'N',1:'T'}},opset_version=17)
    onnx=a.output/'ocr.onnx'
    torch.onnx.export(model,x,str(onnx),input_names=['image'],output_names=['char_logits','color'],
                      dynamic_axes={'image':{0:'N',3:'W'},'char_logits':{0:'N',1:'T'},'color':{0:'N',1:'T'}},
                      opset_version=17,do_constant_folding=True)
    outputs={name:hashlib.sha256((a.output/name).read_bytes()).hexdigest()
             for name in ('backbone.ncnn.param','backbone.ncnn.bin','decoder.onnx','ocr.onnx')}
    (a.output/'build.json').write_text(json.dumps({'source_revision':REVISION,'source_sha256':SOURCE_SHA,'checkpoint_sha256':SHA,
         'torch':torch.__version__,'precision':'fp32','files':outputs},indent=2),encoding='utf-8')
    print('Built original FP32 OCR:',a.output,flush=True)

if __name__=='__main__': main()
