"""Saturate the current native AMD engine over real HTTP, without paid calls.

Each page runs detection/OCR, LaMa and rendering with unique cache scope. Reuse
the sample's previously verified translation to isolate local compute capacity.
Private page data stays in the ignored output directory. No cluster DB or R2 is
opened; concurrency measures engine admission, not user scheduler fairness.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
import uuid

import httpx
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'services/classic-engine'
PYTHON = ENGINE / '.venv/Scripts/python.exe'


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')


def stats(values):
    if not values:
        return None
    return {'mean': float(np.mean(values)), 'p50': float(np.percentile(values, 50)),
            'p95': float(np.percentile(values, 95)), 'max': float(max(values)), 'min': float(min(values))}


@contextmanager
def engine(folder, port, *, optimized=True, threads=4, inpaint_workers=None):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', port))
    folder.mkdir(parents=True, exist_ok=False)
    token = secrets.token_hex(32)
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
        'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'COMSPEC', 'PATHEXT'}}
    env.update(PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8',
               PYTHONPATH=os.pathsep.join([str(ENGINE), str(ROOT/'engines/mit-native')]),
               ENGINE_PROFILE='mit-directml', ENGINE_DEVICE='directml:0',
               ENGINE_RESOURCE_ID=socket.gethostname()+':amd:0', ENGINE_TOKEN=token,
               ENGINE_FONT=str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
               MODEL_DIR=str(ROOT/'engines/mit-models'), ENGINE_LOCK_DIR=str(ROOT/'engines/device-locks'),
               ENGINE_PROFILE_DIR=str(folder/'profiles'), ENGINE_STOP_FILE=str(folder/'engine.stop'),
               ENGINE_DIRECTML_OPTIMIZED='1' if optimized else '0', OMP_NUM_THREADS=str(threads))
    if inpaint_workers is not None:
        env['ENGINE_INPAINT_WORKERS'] = str(inpaint_workers)
    flags = subprocess.CREATE_NO_WINDOW
    with (folder/'engine.log').open('w', encoding='utf-8') as log, (folder/'monitor.log').open('w') as monitor_log:
        child = subprocess.Popen([str(PYTHON), str(ROOT/'scripts/run_local_node.py'), '--engine-process',
                                  '--engine-port', str(port)], env=env, cwd=folder,
                                 stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        monitor = subprocess.Popen(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT/'scripts/monitor_amd_pool.ps1'),
                                    '-EngineProcessIds', str(child.pid), '-OutputPath', str(folder/'resources.jsonl'),
                                    '-StopPath', str(folder/'monitor.stop')], stdout=monitor_log,
                                   stderr=subprocess.STDOUT, creationflags=flags)
        try:
            url = f'http://127.0.0.1:{port}'
            started = time.monotonic()
            while True:
                if child.poll() is not None:
                    raise RuntimeError('Engine startup failed; inspect private engine.log')
                if monitor.poll() is not None:
                    raise RuntimeError('Resource monitor startup failed; inspect private monitor.log')
                try:
                    health = httpx.get(url+'/health', timeout=2, trust_env=False).raise_for_status().json()
                    if health['ready']:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic()-started > 180:
                    raise RuntimeError('Engine readiness timeout')
                time.sleep(.5)
            print(json.dumps({'event':'READY', 'device':health['inference']['adapter'],
                              'capacity':health['capacity'], 'startup_seconds':time.monotonic()-started}), flush=True)
            yield url, token, child, health
        finally:
            (folder/'engine.stop').touch()
            (folder/'monitor.stop').touch()
            for process in (child, monitor):
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)


class Load:
    def __init__(self, url, token, image, translations, expected_segments, folder, version):
        self.url, self.token, self.folder = url, token, folder
        raw = image.read_bytes()
        self.source = np.array(Image.open(BytesIO(raw)).convert('RGB'))
        self.encoded = base64.b64encode(raw).decode()
        self.source_hash = hashlib.sha256(raw).hexdigest()
        self.translations, self.expected_segments = translations, expected_segments
        self.reference = None
        self.use_image_refs = False
        self.config = {'version':version, 'detection_size':1536, 'reading_order':'rtl', 'mask_dilation':3,
                       'inpainting_strategy':'masked-crops-v1', 'inpainting_size':512,
                       'inpainting_padding':48, 'inpainting_merge_gap':24, 'font_minimum':10}
        self.write_lock = threading.Lock()

    def page(self, phase, number):
        row = {'phase':phase, 'number':number, 'start':time.time(), 'success':False, 'http_seconds':{}}
        started = time.monotonic()
        try:
            with httpx.Client(base_url=self.url, headers={'Authorization':'Bearer '+self.token},
                              timeout=300, trust_env=False) as client:
                body = {'image':self.encoded, 'config':self.config, 'scope':str(uuid.uuid4())}
                values = {}
                for stage in ('analyze', 'inpaint', 'render'):
                    began = time.monotonic()
                    response = client.post('/v1/'+stage, json=body)
                    response.raise_for_status()
                    value = response.json()
                    row['http_seconds'][stage] = time.monotonic()-began
                    assert value['input_hash'] == self.source_hash
                    assert [value['height'],value['width']] == list(self.source.shape[:2])
                    values[stage] = value
                    if self.use_image_refs and value.get('image_ref'):
                        body.pop('image', None)
                        body.update(image_ref=value['image_ref'], input_hash=value['input_hash'])
                    if stage == 'analyze':
                        assert value['segments'] == self.expected_segments, 'OCR differs from validated sample'
                        body['analysis'] = value
                    if stage == 'inpaint':
                        assert value['cached'], 'Page exceeded stage cache'
                        body.update(cache_key=value['cache_key'], translations=self.translations, language='zh-Hans')
                result = values['render']
                output = np.array(Image.open(BytesIO(base64.b64decode(result['image']))).convert('RGB'))
                mask = np.array(Image.open(BytesIO(base64.b64decode(result['mask']))).convert('L'))
                glyph = np.array(Image.open(BytesIO(base64.b64decode(result['glyph_mask']))).convert('L'))
                np.testing.assert_array_equal(output[(mask|glyph)==0],self.source[(mask|glyph)==0])
                reference = self.reference
                if reference is None:
                    self.reference = (output,mask,glyph)
                    Image.fromarray(output).save(self.folder/'first-result.png')
                else:
                    np.testing.assert_array_equal(mask,reference[1])
                    np.testing.assert_array_equal(glyph,reference[2])
                    row['max_pixel_difference'] = int(np.abs(output.astype(np.int16)-reference[0]).max())
                row.update(success=True, segments=len(values['analyze']['segments']),
                           timings={k:v for value in values.values() for k,v in value['timings'].items()},
                           cache_rebuilt=result['cache_rebuilt'], output_sha256=hashlib.sha256(output.tobytes()).hexdigest())
        except Exception as error:
            # Do not record bodies, OCR, signed URLs or exception strings.
            row['error_type'] = type(error).__name__
            if isinstance(error, httpx.HTTPStatusError):
                row['http_status'] = error.response.status_code
        row.update(end=time.time(), seconds=time.monotonic()-started)
        with self.write_lock:
            with (self.folder/'pages.jsonl').open('a', encoding='utf-8') as log:
                log.write(json.dumps(row)+'\n')
        return row

    def phase(self, name, concurrency, pages=None, seconds=None):
        began = time.monotonic()
        wall_start = time.time()
        completed = []
        next_number = 0
        def worker():
            nonlocal next_number
            while True:
                with self.write_lock:
                    if pages is not None and next_number >= pages:
                        return
                    if seconds is not None and time.monotonic()-began >= seconds:
                        return
                    number = next_number
                    next_number += 1
                row = self.page(name,number)
                with self.write_lock:
                    completed.append(row)
                    print(json.dumps({'event':'PAGE', 'phase':name, 'completed':len(completed),
                                      'success':row['success'], 'seconds':round(row['seconds'],2)}),flush=True)
                if not row['success']:
                    return
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            for future in as_completed([pool.submit(worker) for _ in range(concurrency)]):
                future.result()
        duration = time.monotonic()-began
        successes = [row for row in completed if row['success']]
        result = {'name':name, 'concurrency':concurrency, 'start':wall_start, 'end':time.time(),
                  'seconds':duration, 'pages':len(completed), 'successes':len(successes),
                  'failures':len(completed)-len(successes), 'pages_per_minute':len(successes)*60/duration,
                  'latency_seconds':stats([row['seconds'] for row in completed]),
                  'stage_seconds':{stage:stats([row['timings'][stage] for row in successes])
                                   for stage in ('detect_ocr','inpaint','render')},
                  'http_seconds':{stage:stats([row['http_seconds'][stage] for row in successes])
                                  for stage in ('analyze','inpaint','render')},
                  'cache_rebuilds':sum(row['cache_rebuilt'] for row in successes),
                  'unique_output_hashes':len({row['output_sha256'] for row in successes}),
                  'max_pixel_difference':max((row.get('max_pixel_difference',0) for row in successes), default=0)}
        print(json.dumps({'event':'PHASE_COMPLETE', **result}),flush=True)
        return result


def summarize_resources(folder, phases):
    samples = [json.loads(line) for line in (folder/'resources.jsonl').read_text(encoding='utf-8').splitlines()]
    for phase in phases:
        rows = [row for row in samples if phase['start'] <= row['timestamp'] <= phase['end']]
        def metric(fn):
            return stats([fn(row) for row in rows])
        phase['resources'] = {
            'samples':len(rows),
            'gpu_busiest_engine_percent':metric(lambda r:max((e['UtilizationPercentage'] for e in r['gpu_engines']),default=0)),
            'gpu_dedicated_bytes':metric(lambda r:sum(m['DedicatedUsage'] for m in r['gpu_process_memory'])),
            'gpu_shared_bytes':metric(lambda r:sum(m['SharedUsage'] for m in r['gpu_process_memory'])),
            'working_set_bytes':metric(lambda r:r['working_set_bytes']),
            'private_bytes':metric(lambda r:r['private_bytes']),
            'cpu_logical_core_percent':metric(lambda r:r['cpu_logical_core_percent'])}
        if rows:
            phase['resources']['first_private_bytes'] = rows[0]['private_bytes']
            phase['resources']['last_private_bytes'] = rows[-1]['private_bytes']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'private-test-data'/('amd-load-'+time.strftime('%Y%m%d-%H%M%S')))
    parser.add_argument('--soak-seconds',type=int,default=300)
    parser.add_argument('--port',type=int,default=18090)
    parser.add_argument('--baseline-v1',action='store_true',help='Reproduce the historical serial AMD runtime')
    args = parser.parse_args()
    if args.soak_seconds < 1:
        parser.error('--soak-seconds must be positive')
    folder = args.directory.resolve()
    detail = json.loads((ROOT/'private-test-data/amd-original-models/stages.json').read_text(encoding='utf-8'))
    report = {'method':'real HTTP, original models, reused translations, no R2/LLM, unique cache scopes', 'phases':[]}
    with engine(folder,args.port,optimized=not args.baseline_v1) as (url,token,child,health):
        report['engine'] = health
        load = Load(url,token,ROOT/'samples/starlight-bookshop.png',detail['translations'],detail['segments'],folder,health['version'])
        report['warmup'] = load.page('warmup',0)
        if not report['warmup']['success']:
            raise RuntimeError('Full-page warmup failed; inspect private pages.jsonl')
        samples = [json.loads(line) for line in (folder/'resources.jsonl').read_text(encoding='utf-8').splitlines()]
        if not any(row['gpu_process_memory'] and row['working_set_bytes'] > 256*1024*1024 for row in samples):
            raise RuntimeError('GPU process telemetry is missing; no capacity result will be reported')
        for concurrency,pages in [(1,6),(2,6),(4,8),(8,16)]:
            result = load.phase('concurrency-'+str(concurrency),concurrency,pages=pages)
            report['phases'].append(result)
            write_json(folder/'report.json',report)
            if result['failures']:
                raise RuntimeError('Load failure; partial report saved')
            result['health_after'] = httpx.get(url+'/health',timeout=30,trust_env=False).raise_for_status().json()
            write_json(folder/'report.json',report)
        report['phases'].append(load.phase('sustained',1,seconds=args.soak_seconds))
        report['health_after'] = httpx.get(url+'/health',timeout=30,trust_env=False).raise_for_status().json()
        write_json(folder/'report.json',report)
    summarize_resources(folder,report['phases'])
    report['status'] = 'failed' if any(phase['failures'] for phase in report['phases']) else 'passed'
    write_json(folder/'report.json',report)
    print(json.dumps({'event':'BENCHMARK_COMPLETE','report':str(folder/'report.json')}),flush=True)
    if report['status'] != 'passed':
        raise RuntimeError('Sustained load failed; report saved')


if __name__ == '__main__':
    main()
