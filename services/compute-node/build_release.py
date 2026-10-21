"""Internal orchestrator; start with build.ps1 from a clean source checkout."""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import tomllib

# The bootstrap uses -I: import only the helper adjacent to this source file.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_support import (archive_release, build_environment, copy_sources, download,
                           event, remove_unused_launchers, run, safe_extract_zip, sha256)

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT.parent / 'classic-engine'


class Builder:
    def __init__(self, args):
        self.output, self.work, self.session = args.output.resolve(), args.work.resolve(), args.run.resolve()
        self.version, self.uv = args.version, args.uv.resolve()
        self.backend = getattr(args, 'backend', 'cuda')
        self.lock = json.loads((ROOT / 'toolchain.lock.json').read_text(encoding='utf-8'))
        if sys.platform != 'win32' or sys.maxsize <= 2**32 or sys.version.split()[0] != self.lock['python']['version']:
            raise RuntimeError('Use build.ps1 with its pinned Windows x64 Python runtime')
        if Path(sys.executable).resolve() != self.session / 'python/python.exe':
            raise RuntimeError('Build interpreter must belong to the isolated bootstrap session')
        self.env = build_environment(self.work)
        if run([self.uv, '--version'], cwd=ROOT, env=self.env, capture=True).split()[1] != self.lock['uv']['version']:
            raise RuntimeError('uv version mismatch')
        self.downloads = self.work / 'downloads'
        self.assets = self.session / 'assets'
        self.tool_envs = {}

    def requirements(self, project, target):
        run([self.uv, 'export', '--project', project, '--frozen', '--no-dev', '--no-emit-project',
             '--no-emit-package', 'node-comics-classic-engine',
             '--no-emit-package', 'comic-document-files',
             '--no-editable', '--no-header', '--no-annotate', '--output-file', target], cwd=ROOT, env=self.env, capture=True)
        content = target.read_text(encoding='utf-8')
        # uv export omits index URLs. Keep CUDA artifacts tied directly
        # to its locked Windows wheel, without changing global index priority.
        lock = tomllib.loads((project / 'uv.lock').read_text(encoding='utf-8'))
        amd_pins = json.loads((ROOT / 'portable-amd-artifacts.json').read_text(encoding='utf-8'))
        for package in lock['package']:
            name = package['name']
            if name in ('torch', 'torchvision') and re.search(r'^' + name + '==', content, re.MULTILINE):
                wheels = [item for item in package.get('wheels', []) if item['url'].endswith('cp312-cp312-win_amd64.whl')]
                if len(wheels) != 1:
                    raise ValueError('Expected one locked CPython 3.12 Windows CUDA wheel: ' + name)
                requirement = name + ' @ ' + wheels[0]['url'] + ' --hash=' + wheels[0]['hash']
                content = re.sub(r'^' + name + r'==[^\n]*(?:\n[ \t]+[^\n]*)*',
                                 lambda match: requirement, content, flags=re.MULTILINE)
            if name in amd_pins and re.search(r'^' + name + '==', content, re.MULTILINE):
                artifact = amd_pins[name]
                sources = package.get('wheels', []) + ([package['sdist']] if 'sdist' in package else [])
                if package['version'] != artifact['version'] or artifact['url'] not in [item['url'] for item in sources]:
                    raise ValueError('AMD artifact pin differs from environment lock: ' + name)
                requirement = name + ' @ ' + artifact['url'] + ' --hash=sha256:' + artifact['sha256']
                content = re.sub(r'^' + name + r'==[^\n]*(?:\n[ \t]+[^\n]*)*',
                                 lambda match: requirement, content, flags=re.MULTILINE)
        target.write_text(content, encoding='utf-8', newline='\n')

    def environment(self, name):
        event('build_environment', name=name)
        directory = self.session / ('env-' + name)
        run([self.uv, 'venv', '--python', sys.executable, directory], cwd=ROOT, env=self.env)
        python = directory / 'Scripts/python.exe'
        requirements = self.session / (name + '-requirements.txt')
        self.requirements(ROOT / 'build-deps' / name, requirements)
        run([self.uv, 'pip', 'install', '--python', python, '--require-hashes', '--only-binary', ':all:',
             '-r', requirements], cwd=ROOT, env=self.env)
        self.tool_envs[name] = python
        return python

    def prepare_go(self):
        asset = self.lock['go']
        archive = download(asset['url'], asset['sha256'], self.downloads / 'go.zip')
        safe_extract_zip(archive, self.session)
        self.go_root = self.session / 'go'
        self.go = self.go_root / 'bin/go.exe'
        self.env = build_environment(self.work, self.go_root)
        actual = run([self.go, 'version'], cwd=ROOT, env=self.env, capture=True)
        if actual != 'go version go' + asset['version'] + ' windows/amd64':
            raise RuntimeError('Go version mismatch')

    def prepare_models(self):
        event('prepare_models')
        sys.path.insert(0, str(ENGINE))
        from tools.prepare_mtu import prepare
        prepare(self.assets, self.downloads)

    def package_runtime(self):
        event('package_runtime')
        runtime = self.output / 'runtime'
        runtime.mkdir()
        base = self.session / 'python'
        for name in ('python.exe', 'pythonw.exe', 'LICENSE.txt'):
            shutil.copy2(base / name, runtime / name)
        for path in base.glob('*.dll'):
            shutil.copy2(path, runtime / path.name)
        copy_sources(base / 'DLLs', runtime / 'DLLs')
        shutil.copytree(base / 'Lib', runtime / 'Lib', ignore=shutil.ignore_patterns(
            'site-packages', '__pycache__', '*.pyc', 'test', 'tests', 'idlelib', 'tkinter', 'turtledemo', 'ensurepip'))
        (runtime / 'python312._pth').write_text('.\nDLLs\nLib\nLib/site-packages\nimport site\n', encoding='ascii')
        requirements = self.output / 'runtime-requirements.txt'
        self.requirements(ENGINE / 'environments/amd' if self.backend == 'amd' else ENGINE, requirements)
        packaging_python = self.environment('packaging')
        # Source-only antlr4 builds using locked setuptools/wheel, without PEP 517 downloads.
        run([self.uv, 'pip', 'install', '--python', packaging_python, '--target', runtime / 'Lib/site-packages',
             '--require-hashes', '--no-build-isolation', '-r', requirements], cwd=ROOT, env=self.env)
        remove_unused_launchers(runtime / 'Lib/site-packages')
        for directory in ('upstream', 'models', 'fonts', 'licenses', 'hyphenation'):
            shutil.copytree(self.assets / directory, self.output / directory)
        shutil.copy2(self.assets / 'mtu-assets.json', self.output / 'mtu-assets.json')
        # Application code belongs to the small update package, not the cached
        # environment. Asset verification only needs the bootstrap standard library.
        code = ('import json, sys; sys.path.insert(0, sys.argv[1]); from mtu_engine.assets import verify; '
                'print(json.dumps(verify(sys.argv[2])["files"]))')
        verified = json.loads(run([sys.executable, '-I', '-B', '-c', code, ENGINE, self.output / 'models'],
                                  cwd=self.output, env=self.env, capture=True))
        self.model_hashes = {name: value for name, value in verified.items() if name.startswith('models/')}
        event('models_verified', files=len(verified))

    def package_fonts(self):
        assets = json.loads((ROOT / 'assets.json').read_text(encoding='utf-8'))
        self.fonts = ['fonts/' + font['name'] for font in assets['fonts']]

    def package_sources(self):
        source = self.output / 'source'
        # Preserve ../../backend/document_files as referenced by the engine lock.
        copy_sources(ENGINE.parent.parent / 'backend/document_files', self.output / 'backend/document_files')
        host = source / 'compute-node'
        host.mkdir(parents=True)
        for pattern in ('*.go', '*.py', '*.ps1', '*.cmd', '*.json', 'go.mod', 'go.sum', 'README.md', 'LICENSE'):
            for path in ROOT.glob(pattern):
                shutil.copy2(path, host / path.name)
        copy_sources(ROOT / 'build-deps', host / 'build-deps')
        copy_sources(ROOT / 'tests', host / 'tests')
        engine = source / 'classic-engine'
        for directory in ('classic_node', 'mtu_engine', 'tools', 'docs'):
            copy_sources(ENGINE / directory, engine / directory)
        amd = engine / 'environments/amd'
        amd.mkdir(parents=True)
        for name in ('pyproject.toml', 'uv.lock'):
            shutil.copy2(ENGINE / 'environments/amd' / name, amd / name)
        for name in ('LICENSE', 'THIRD_PARTY.md', 'uv.lock', 'pyproject.toml', 'README.md', 'ENGINE.md'):
            shutil.copy2(ENGINE / name, engine / name)
        (self.output / 'licenses').mkdir(exist_ok=True)
        for name in ('sys', 'term'):
            module = json.loads(run([self.go, 'list', '-m', '-json', 'golang.org/x/' + name], cwd=ROOT, env=self.env, capture=True))
            shutil.copy2(Path(module['Dir']) / 'LICENSE', self.output / 'licenses' / f'go-x-{name}-LICENSE')
        shutil.copy2(self.go_root / 'LICENSE', self.output / 'licenses/Go-LICENSE')
        shutil.copy2(ROOT / 'toolchain.lock.json', self.output / 'licenses/toolchain.lock.json')
        readme = (ROOT / 'README.md').read_text(encoding='utf-8').replace(
            '../classic-engine/docs/NODE_OPERATIONS.md', 'source/classic-engine/docs/NODE_OPERATIONS.md')
        (self.output / 'README.md').write_text(readme, encoding='utf-8', newline='\n')
    def build(self):
        if self.output.exists():
            raise ValueError('Output must be a new directory; never overwrite a configured node')
        self.output.mkdir(parents=True)
        self.prepare_go()
        self.environment('packaging')
        event('native_host')
        run([self.go, 'build', '-trimpath', '-buildvcs=false', '-ldflags', f'-s -w -X main.version={self.version}',
             '-o', self.output / 'node.exe', '.'], cwd=ROOT, env=self.env)
        run([self.go, 'test', '.'], cwd=ROOT, env=self.env)
        run([self.go, 'vet', '.'], cwd=ROOT, env=self.env)
        run([self.tool_envs['packaging'], '-B', '-m', 'pytest', ROOT / 'test_build_release.py',
             ROOT / 'test_portable.py', ROOT / 'test_run_node.py', '-q'], cwd=ROOT, env=self.env)
        self.package_sources()
        for name in ('Start.cmd', 'Stop.cmd', 'Status.cmd', 'Enable-Autostart.cmd', 'Disable-Autostart.cmd'):
            shutil.copy2(ROOT / name, self.output / name)
        self.write_manifest('portable.json')

    def write_manifest(self, filename='release.json'):
        portable = filename == 'portable.json'
        manifest = {'version': self.version, 'platform': 'windows-amd64', 'python': self.lock['python']['version'],
                    'toolchain': self.lock, 'models': {} if portable else self.model_hashes,
                    'fonts': [] if portable else self.fonts,
                    'files': {p.relative_to(self.output).as_posix(): sha256(p)
                              for p in sorted(self.output.rglob('*')) if p.is_file()}}
        if portable:
            manifest['format'] = 'gpu-portable-v1'
            manifest['requirements_sha256'] = {}
            for backend, project in (('cuda', ENGINE), ('amd', ENGINE / 'environments/amd')):
                target = self.session / (backend + '-requirements.txt')
                self.requirements(project, target)
                manifest['requirements_sha256'][backend] = sha256(target)
        else:
            manifest['backend'] = self.backend
        (self.output / filename).write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
        event('release_complete', release=str(self.output), files=len(manifest['files']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--uv', type=Path, required=True)
    parser.add_argument('--zip', action='store_true')
    args = parser.parse_args()
    builder = Builder(args)
    builder.build()
    if args.zip:
        archive_release(builder.output, manifest_name='portable.json')


if __name__ == '__main__':
    main()
