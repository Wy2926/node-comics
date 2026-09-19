import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import threading
import time
import urllib.request
import numpy as np
import psutil
from .backend import devices
from .engine import Engine
from .translation import Translator, atomic_json
from .telemetry import GpuCounters
from .languages import language_code


def validate_outputs(paths, output):
    if len({p.stem.casefold() for p in paths})!=len(paths):
        raise ValueError('Input names share a stem; output PNG names would collide')
    sources={p.resolve() for p in paths}
    if any((output/f'{p.stem}.png').resolve() in sources for p in paths):
        raise ValueError('Output would overwrite an input image; choose another --output')


def download(models,language='ja'):
    root=Path(models);root.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((Path(__file__).parent/'models.json').read_text(encoding='utf-8'))
    for item in manifest['models']:
        if item.get('language') and language not in ('all',item['language']): continue
        path=root/item['name']
        path.parent.mkdir(parents=True,exist_ok=True)
        if not path.exists():
            temp=path.with_suffix(path.suffix+'.download')
            urllib.request.urlretrieve(item['url'],temp)
            if hashlib.sha256(temp.read_bytes()).hexdigest()!=item['sha256']:
                raise RuntimeError(f'Checksum mismatch: {item["name"]}')
            temp.replace(path)
        if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:
            raise RuntimeError(f'Checksum mismatch: {item["name"]}')
        print(f'Verified {path}',flush=True)


class Monitor:
    def __init__(self):
        self.stop=threading.Event();self.samples=[];self.process=psutil.Process()
        self.thread=threading.Thread(target=self.sample,daemon=True)
    def sample(self):
        gpu=GpuCounters()
        self.process.cpu_percent();psutil.cpu_percent()
        while not self.stop.wait(.2):
            self.samples.append({'process_cpu_cores':self.process.cpu_percent()/100,
                                 'system_cpu_percent':psutil.cpu_percent(),
                                 'rss_mb':self.process.memory_info().rss/2**20,
                                 'gpu_busiest_engine_percent':gpu.read()})
        gpu.close()
    def __enter__(self): self.thread.start();return self
    def __exit__(self,*args): self.stop.set();self.thread.join()


def main():
    p=argparse.ArgumentParser(description='Yakuyomi PC: Vulkan detection, OCR backbone and inpainting')
    p.add_argument('command',choices=['devices','download','run'])
    p.add_argument('input',nargs='?',type=Path)
    p.add_argument('--output',type=Path,default=Path('artifacts/translated'))
    p.add_argument('--models',default='models')
    p.add_argument('--gpu',type=int,default=0,help='Vulkan index; -1 explicitly selects CPU')
    p.add_argument('--ocr-workers',type=int,default=8)
    p.add_argument('--threads',type=int,default=2)
    p.add_argument('--pages',type=int,default=2,help='Bounded pages in flight')
    p.add_argument('--tile',type=int,default=768)
    p.add_argument('--detect-size',type=int,choices=[1024,1280,1536,2048],default=1280)
    p.add_argument('--font',action='append',help='Font path; repeat to add fallback fonts')
    p.add_argument('--ocr-language',choices=['auto','ja','zh','en','ko','latin','all'],default='auto',help='auto uses --source; all is for download only')
    p.add_argument('--direction',choices=['auto','horizontal','vertical'],default='auto',help='Target direction; auto keeps CJK direction and uses horizontal English/Korean')
    p.add_argument('--png-compression',type=int,choices=range(10),default=1)
    p.add_argument('--translation',choices=['online','offline'],default='offline')
    p.add_argument('--base-url',default='https://sub2api.nodelane.net')
    p.add_argument('--model',default='gpt-5.6-luna')
    p.add_argument('--source',default='Japanese')
    p.add_argument('--target',default='Simplified Chinese')
    p.add_argument('--cache',default='cache/translations')
    p.add_argument('--glossary',type=Path,help='JSON source-to-target terminology map; included in cache key')
    p.add_argument('--limit',type=int)
    a=p.parse_args()
    if a.command=='devices': print(json.dumps(devices(),indent=2));return
    ocr_language=language_code(a.source) if a.ocr_language=='auto' else a.ocr_language
    if ocr_language is None: p.error('Cannot select OCR from --source; specify --ocr-language')
    if a.command=='download': download(a.models,ocr_language);return
    if ocr_language=='all': p.error('--ocr-language all is for download only')
    if not a.input: p.error('run requires an input image or directory')
    if min(a.pages,a.ocr_workers,a.threads)<1: p.error('worker counts must be positive')
    if a.tile<256 or a.tile%128: p.error('--tile must be a multiple of 128 and at least 256')
    paths=sorted(f for f in a.input.iterdir() if f.suffix.lower() in ('.webp','.png','.jpg','.jpeg')) if a.input.is_dir() else [a.input]
    if a.limit: paths=paths[:a.limit]
    if not paths: p.error('No input images')
    validate_outputs(paths,a.output)
    glossary=json.loads(a.glossary.read_text(encoding='utf-8-sig')) if a.glossary else None
    translator=Translator(a.cache,a.base_url,a.model,a.translation,a.source,a.target,glossary)
    started=time.perf_counter()
    engine=Engine(a.models,a.gpu,a.ocr_workers,a.threads,a.tile,a.font,a.png_compression,a.detect_size,ocr_language,a.direction)
    try:
        engine.warmup();startup=time.perf_counter()-started
        records=[];errors=[];start=time.perf_counter()
        with Monitor() as monitor,ThreadPoolExecutor(a.pages,thread_name_prefix='page') as pool:
            pending={};iterator=iter(paths)
            # Submit only depth pages: don't retain a whole chapter's decoded images.
            for path in list(paths[:a.pages]): pending[pool.submit(engine.page,path,translator,a.output)]=path
            iterator=iter(paths[a.pages:])
            while pending:
                future=next(as_completed(pending));path=pending.pop(future)
                try:
                    record=future.result();records.append(record)
                    print(f'{path.name}: {record["timings"]["total"]:.3f}s, {record["recognized_lines"]} lines',flush=True)
                except Exception as exc:
                    errors.append({'page':path.name,'error':str(exc)})
                    print(f'{path.name}: FAILED {exc}',flush=True)
                if (next_path:=next(iterator,None)) is not None:
                    pending[pool.submit(engine.page,next_path,translator,a.output)]=next_path
        elapsed=time.perf_counter()-start
        latencies=[r['timings']['total'] for r in records]
        report={'config':{k:str(v) if isinstance(v,Path) else v for k,v in vars(a).items()}|{'detect_size':engine.detect_size},
                'devices':devices() if a.gpu>=0 else [],'ocr_provider':engine.ocr.provider,
                'runtime_fp16':False,
                'startup_warmup_s':startup,'wall_s':elapsed,'successful_pages':len(records),
                'pages_per_minute':len(records)*60/elapsed,'mean_page_s':float(np.mean(latencies)) if latencies else None,
                'p95_page_s':float(np.quantile(latencies,.95)) if latencies else None,
                'translation':translator.stats,'errors':errors,'pages':sorted(records,key=lambda x:x['page']),
                'resources':{'mean_process_cpu_cores':float(np.mean([s['process_cpu_cores'] for s in monitor.samples])) if monitor.samples else None,
                    'mean_system_cpu_percent':float(np.mean([s['system_cpu_percent'] for s in monitor.samples])) if monitor.samples else None,
                    'peak_rss_mb':max([s['rss_mb'] for s in monitor.samples],default=0),
                    'gpu_busiest_engine_mean_percent':float(np.mean([s['gpu_busiest_engine_percent'] for s in monitor.samples if s['gpu_busiest_engine_percent'] is not None])) if any(s['gpu_busiest_engine_percent'] is not None for s in monitor.samples) else None}}
        atomic_json(a.output/'report.json',report)
        print(json.dumps({k:v for k,v in report.items() if k not in ('pages','config')},ensure_ascii=False,indent=2))
        if errors: raise SystemExit(1)
    finally: engine.close()

if __name__=='__main__': main()
