"""Bounded offline chapter benchmarks, with pixel parity against the first run."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from PIL import Image
from manhua_engine.translation import atomic_json


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input');p.add_argument('--source',default='Japanese')
    p.add_argument('--target',default='Simplified Chinese')
    p.add_argument('--configs',default='1:8,2:8,4:8',help='pages:ocr_workers comma-separated')
    p.add_argument('--output',type=Path,default=Path('artifacts/benchmark'))
    a=p.parse_args();rows=[];reference=None
    for entry in a.configs.split(','):
        depth,workers=map(int,entry.split(':'))
        if min(depth,workers)<1: p.error('pages and OCR workers must be positive')
        out=a.output/f'd{depth}-w{workers}';out.mkdir(parents=True,exist_ok=True)
        command=[sys.executable,'-m','manhua_engine.cli','run',a.input,'--output',str(out),
                 '--pages',str(depth),'--ocr-workers',str(workers),'--translation','offline',
                 '--source',a.source,'--target',a.target]
        with (out/'run.log').open('w',encoding='utf-8') as log:
            result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
        if result.returncode: raise RuntimeError(f'Failed: {out}/run.log')
        report=json.loads((out/'report.json').read_text(encoding='utf-8'))
        if reference is None: reference=out
        same=True
        for record in report['pages']:
            name=Path(record['page']).with_suffix('.png').name
            with Image.open(out/name) as actual,Image.open(reference/name) as expected:
                same &= actual.size==expected.size and actual.tobytes()==expected.tobytes()
        row={k:report[k] for k in ('wall_s','pages_per_minute','mean_page_s','p95_page_s','resources','translation')}
        row.update(depth=depth,ocr_workers=workers,identical_pixels=same)
        rows.append(row);atomic_json(a.output/'report.json',rows)
        print(json.dumps(row),flush=True)
        if not same: raise RuntimeError('Concurrent output differs from the first benchmark run')


if __name__=='__main__': main()
