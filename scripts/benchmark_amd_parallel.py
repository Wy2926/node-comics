"""Compare real bounded model-process concurrency on one reserved physical GPU.

Standalone compute experiment: no controller registrations, DB, R2 or LLM calls.
The supervisor owns the ordinary physical device lock across all worker pools.
One closed-loop client per model instance preserves inpaint/render cache affinity.
"""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import threading
import time

import httpx

from benchmark_amd import ROOT, ENGINE, PYTHON, Load, stats, summarize_resources, write_json
sys.path.insert(0, str(ENGINE))
from runtime import DeviceLock

RESOURCE_ID = socket.gethostname() + ':amd:0'


@contextmanager
def pool(folder, instances, threads, gpu_ocr):
    folder.mkdir(parents=True, exist_ok=False)
    env = {k:v for k,v in os.environ.items() if k.upper() in {
        'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
        'PROGRAMFILES','PROGRAMDATA','COMSPEC','PATHEXT'}}
    token = secrets.token_hex(32)
    env.update(PYTHONUNBUFFERED='1',PYTHONIOENCODING='utf-8',ENGINE_PROFILE='mit-directml',
               ENGINE_DEVICE='directml:0',ENGINE_RESOURCE_ID=RESOURCE_ID,ENGINE_TOKEN=token,
               ENGINE_VERSION='mit-95227a2-classic-v4-dml-gpuocr-v1' if gpu_ocr else 'mit-95227a2-classic-v4-dml-v1',
               ENGINE_FONT=str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
               MODEL_DIR=str(ROOT/'engines/mit-models'),ENGINE_LOCK_DIR=str(ROOT/'engines/device-locks'),
               OMP_NUM_THREADS=str(threads),BENCHMARK_GPU_OCR='1' if gpu_ocr else '0',ENGINE_DIRECTML_OPTIMIZED='0')
    children, handles, urls = [], [], []
    monitor = None
    try:
        for slot in range(instances):
            port = 18100 + slot
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',port))
            worker_folder = folder/('worker-'+str(slot))
            worker_folder.mkdir()
            output = (worker_folder/'engine.log').open('w',encoding='utf-8')
            handles.append(output)
            worker_env = {**env,'ENGINE_PROFILE_DIR':str(worker_folder/'profiles'), 'ENGINE_TRACE_DEVICES':'1',
                          'ENGINE_STOP_FILE':str(folder/'engine.stop'),'BENCHMARK_POOL_SLOT':str(slot),
                          'BENCHMARK_PORT':str(port)}
            children.append(subprocess.Popen([str(PYTHON),str(ROOT/'scripts/benchmark_amd_worker.py')],
                                             cwd=folder,env=worker_env,stdout=output,stderr=subprocess.STDOUT,
                                             creationflags=subprocess.CREATE_NO_WINDOW))
            urls.append(f'http://127.0.0.1:{port}')
        output = (folder/'monitor.log').open('w')
        handles.append(output)
        monitor = subprocess.Popen(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',
                                    str(ROOT/'scripts/monitor_amd_pool.ps1'),'-EngineProcessIds',
                                    ','.join(str(child.pid) for child in children),'-OutputPath',str(folder/'resources.jsonl'),
                                    '-StopPath',str(folder/'monitor.stop')],stdout=output,stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        healths = []
        until = time.monotonic()+180
        for url in urls:
            while True:
                if any(child.poll() is not None for child in children) or monitor.poll() is not None:
                    raise RuntimeError('Pool service exited; inspect private logs')
                try:
                    health = httpx.get(url+'/health',timeout=2,trust_env=False).raise_for_status().json()
                    if health['ready']:
                        healths.append(health)
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic()>until:
                    raise RuntimeError('Pool startup timeout')
                time.sleep(.5)
        print(json.dumps({'event':'POOL_READY','instances':instances,'threads_per_instance':threads,'gpu_ocr':gpu_ocr}),flush=True)
        yield urls,token,healths
    finally:
        (folder/'engine.stop').touch(); (folder/'monitor.stop').touch()
        for child in [*children, *([monitor] if monitor else [])]:
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.terminate(); child.wait(timeout=10)
        for handle in handles:
            handle.close()


def measure(folder, urls, token, healths, detail, reference, pages_per_worker, seconds):
    loads = []
    for index,(url,health) in enumerate(zip(urls,healths)):
        load = Load(url,token,ROOT/'samples/starlight-bookshop.png',detail['translations'],detail['segments'],
                    folder/('worker-'+str(index)),health['version'])
        # Warm all model paths before measuring. Compare every instance with the
        # same serial hybrid baseline, including masks and final output pixels.
        warmup = load.page('warmup',0)
        if not warmup['success']:
            raise RuntimeError('Worker warmup failed')
        if reference is None:
            reference = load.reference
        load.reference = reference
        verified = load.page('warmup-parity',1)
        if not verified['success'] or verified['max_pixel_difference'] != 0:
            raise RuntimeError('Worker differs from serial original-model output')
        loads.append(load)
    samples = [json.loads(line) for line in (folder/'resources.jsonl').read_text().splitlines()]
    if not any(len(row['gpu_process_memory']) >= len(loads) for row in samples):
        raise RuntimeError('GPU process telemetry incomplete')
    barrier = threading.Barrier(len(loads)+1)
    rows, mutex = [], threading.Lock()
    started = None
    def run(index,load):
        barrier.wait()
        number = 0
        while (seconds is not None and time.monotonic()-started < seconds) or (seconds is None and number < pages_per_worker):
            row = load.page('parallel',number)
            row['worker'] = index
            with mutex:
                rows.append(row)
                print(json.dumps({'event':'PAGE','pool':folder.name,'worker':index,'completed':len(rows),
                                  'success':row['success'],'seconds':round(row['seconds'],2)}),flush=True)
            if not row['success'] or row.get('max_pixel_difference',0) != 0:
                raise RuntimeError('Parallel output failed quality verification')
            number += 1
    with ThreadPoolExecutor(max_workers=len(loads)) as executor:
        futures = [executor.submit(run,index,load) for index,load in enumerate(loads)]
        started = time.monotonic(); wall_start = time.time(); barrier.wait()
        for future in as_completed(futures):
            future.result()
    duration = time.monotonic()-started
    result = {'name':folder.name,'start':wall_start,'end':time.time(),'seconds':duration,'pages':len(rows),
              'successes':sum(row['success'] for row in rows),'failures':sum(not row['success'] for row in rows),
              'pages_per_minute':len(rows)*60/duration,'latency_seconds':stats([row['seconds'] for row in rows]),
              'stage_seconds':{stage:stats([row['timings'][stage] for row in rows]) for stage in ('detect_ocr','inpaint','render')},
              'cache_rebuilds':sum(row['cache_rebuilt'] for row in rows),
              'unique_output_hashes':len({row['output_sha256'] for row in rows}),
              'max_pixel_difference':max(row.get('max_pixel_difference',0) for row in rows),
              'worker_pages':[sum(row['worker']==index for row in rows) for index in range(len(loads))],
              'summed_model_wall_seconds':sum(sum(row['timings'].values()) for row in rows),
              'health_after':[httpx.get(url+'/health',timeout=30,trust_env=False).raise_for_status().json() for url in urls]}
    write_json(folder/'pages.json',rows); write_json(folder/'report.json',result)
    return result,reference


async def main(args):
    folder = args.directory.resolve();folder.mkdir(parents=True,exist_ok=False)
    detail = json.loads((ROOT/'private-test-data/amd-original-models/stages.json').read_text(encoding='utf-8'))
    report = {'scope':'isolated physical GPU reservation, same-image original-model HTTP pipeline, no LLM/R2', 'phases':[]}
    reference = None
    reservation = DeviceLock(RESOURCE_ID,str(ROOT/'engines/device-locks')).hold()
    await asyncio.wait_for(reservation.__aenter__(),timeout=5)
    try:
        # Hold threads constant for the primary instance-count comparison.
        configs = args.matrix
        for instances,threads,gpu in configs:
            name = f'{instances}x{threads}-'+('gpuocr' if gpu else 'hybrid')
            target = folder/name
            with pool(target,instances,threads,gpu) as (urls,token,healths):
                result,reference = measure(target,urls,token,healths,detail,reference,args.pages_per_worker,None)
            result.update(instances=instances,threads_per_instance=threads,gpu_ocr=gpu)
            summarize_resources(target,[result]);report['phases'].append(result)
            write_json(target/'report.json',result);write_json(folder/'report.json',report)
            print(json.dumps({'event':'POOL_COMPLETE','name':name,'pages_per_minute':result['pages_per_minute'],
                              'mean_seconds':result['latency_seconds']['mean']}),flush=True)
        best = max(report['phases'],key=lambda row:row['pages_per_minute'])
        target = folder/'sustained-best'
        with pool(target,best['instances'],best['threads_per_instance'],best['gpu_ocr']) as (urls,token,healths):
            result,reference = measure(target,urls,token,healths,detail,reference,None,args.soak_seconds)
        result.update(instances=best['instances'],threads_per_instance=best['threads_per_instance'],gpu_ocr=best['gpu_ocr'])
        summarize_resources(target,[result]);report['sustained']=result
        write_json(target/'report.json',result);write_json(folder/'report.json',report)
        print(json.dumps({'event':'PARALLEL_BENCHMARK_COMPLETE','report':str(folder/'report.json')}),flush=True)
    finally:
        await reservation.__aexit__(None,None,None)


if __name__ == '__main__':
    def configuration(value):
        match = re.fullmatch(r'([1-4])x([124])-(hybrid|gpuocr)',value)
        if not match:
            raise argparse.ArgumentTypeError('Expected instances x threads - hybrid/gpuocr, for example 3x2-gpuocr')
        return int(match[1]),int(match[2]),match[3]=='gpuocr'

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=ROOT/'private-test-data'/('amd-parallel-'+time.strftime('%Y%m%d-%H%M%S')))
    parser.add_argument('--pages-per-worker',type=int,default=6)
    parser.add_argument('--soak-seconds',type=int,default=300)
    parser.add_argument('--matrix',nargs='+',type=configuration,
                        default=[(1,4,False),(1,4,True),(2,4,True),(4,4,True),(4,2,True)])
    args = parser.parse_args()
    if args.pages_per_worker<1 or args.soak_seconds<1:
        parser.error('Page count and duration must be positive')
    asyncio.run(main(args))
