"""Export the built image runtime for an existing Ubuntu 24.04 GPU container."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', default='node-comics-compute:linux-cuda')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    metadata = output.with_suffix(output.suffix + '.json')
    if output.exists() or metadata.exists():
        parser.error('output already exists; use a new release filename')
    output.parent.mkdir(parents=True, exist_ok=True)
    inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', args.image]))[0]
    if (inspected['Os'], inspected['Architecture']) != ('linux', 'amd64'):
        parser.error('requires a linux/amd64 image')
    container = subprocess.check_output(['docker', 'create', inspected['Id']], text=True).strip()
    try:
        with output.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as archive:
            proc = subprocess.Popen(['docker', 'cp', f'{container}:/opt/node/.', '-'], stdout=subprocess.PIPE)
            try:
                shutil.copyfileobj(proc.stdout, archive, 1024 * 1024)
            finally:
                proc.stdout.close()
                result = proc.wait()
            if result:
                raise subprocess.CalledProcessError(result, proc.args)
        with output.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        metadata.write_text(json.dumps({'image_id': inspected['Id'], 'sha256': digest,
            'bytes': output.stat().st_size, 'platform': 'linux/amd64',
            'runtime_path': '/opt/node', 'requires': 'Ubuntu 24.04, Python 3.12, CUDA 12.8, cuDNN 9, NVIDIA Vulkan'},
            indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'archive': str(output), 'metadata': str(metadata), 'sha256': digest}))
    finally:
        subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
