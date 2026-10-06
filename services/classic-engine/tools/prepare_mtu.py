"""Prepare checksum-pinned MTU source, native models and fonts without GPU access."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import zipfile

ENGINE = Path(__file__).resolve().parents[1]
HOST = ENGINE.parent / 'compute-node'
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(HOST))
from build_support import download, sha256
from mtu_engine.assets import LOCK


def prepare(output, cache):
    output, cache = Path(output).resolve(), Path(cache).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'node.json').exists() or (output / 'state').exists():
        raise ValueError('Prepare assets outside a configured node state directory')
    # These generated directories belong to this preparer. Rebuild them from
    # the checksum cache so removed models/source cannot survive an upgrade.
    for name in ('upstream', 'models', 'fonts', 'licenses', 'hyphenation'):
        directory = (output / name).resolve()
        if not directory.is_relative_to(output) or directory == output:
            raise ValueError('Unsafe asset output path')
        if directory.exists():
            shutil.rmtree(directory)
    for key, repository, module in (('source', 'manga-translator-ui', 'manga_translator'),
                                     ('ballons', 'BallonsTranslator', 'ballontranslator')):
        source = LOCK[key]
        archive = download(source['url'], source['sha256'], cache / source['sha256'])
        with zipfile.ZipFile(archive) as package:
            prefix = repository + '-' + source['revision'] + '/'
            for info in package.infolist():
                if info.is_dir() or not info.filename.startswith(prefix):
                    continue
                relative = info.filename[len(prefix):]
                if not (relative.startswith(module + '/') or (key == 'ballons' and relative.startswith('resources/')) or relative in (
                        'LICENSE', 'LICENSE.txt', 'pyproject.toml', 'uv.lock', 'requirements.txt')):
                    continue
                if key == 'ballons' and '/' not in relative:
                    relative = repository + '-' + relative
                target = (output / 'upstream' / relative).resolve()
                if not target.is_relative_to(output / 'upstream'):
                    raise ValueError('Unsafe upstream archive path')
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(info) as src, target.open('wb') as dst:
                    shutil.copyfileobj(src, dst)
    # The native paragraph grouping imports BallonsTranslator's text types.
    for relative in ('config/textstyles', 'data'):
        directory = output / 'upstream' / relative
        directory.mkdir(parents=True, exist_ok=True)
        (directory / '.node-prepared').write_text('Prepared for paragraph grouping imports.\n', encoding='utf-8')
    for asset in LOCK['models']:
        cached = download(asset['url'], asset['sha256'], cache / asset['sha256'])
        if 'archive' in asset:
            with zipfile.ZipFile(cached) as package:
                for name, relative in asset['archive'].items():
                    target = output / 'models' / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(name) as src, target.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
        else:
            target = output / 'models' / asset['file']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cached, target)
    dictionaries = LOCK['hyphenation']
    wheel = download(dictionaries['url'], dictionaries['sha256'], cache / dictionaries['sha256'])
    registry = {}
    directory = output / 'hyphenation'
    directory.mkdir(exist_ok=True)
    with zipfile.ZipFile(wheel) as package:
        for info in package.infolist():
            if info.is_dir() or not info.filename.startswith('pyphen/dictionaries/'):
                continue
            name = Path(info.filename).name
            with package.open(info) as src, (directory / name).open('wb') as dst:
                shutil.copyfileobj(src, dst)
            if name.startswith('hyph_') and name.endswith('.dic'):
                locale = name[5:-4]
                record = {'file': name, 'url': dictionaries['source']}
                registry[locale] = registry[locale.replace('_', '-')] = record
    for language, locale in {'en': 'en_US', 'de': 'de_DE', 'fr': 'fr', 'es': 'es',
                              'it': 'it_IT', 'pt': 'pt_BR', 'pl': 'pl_PL', 'ru': 'ru_RU',
                              'uk': 'uk_UA', 'tr': 'tr_TR'}.items():
        if locale in registry:
            registry[language] = registry[locale]
    (directory / 'dictionaries.json').write_text(json.dumps(registry, indent=2) + '\n', encoding='utf-8')
    fonts = json.loads((HOST / 'assets.json').read_text(encoding='utf-8'))['fonts']
    for font in fonts:
        for directory, name, url, checksum in (
            ('fonts', font['name'], font['url'], font['sha256']),
            ('licenses', font['notice'], font['notice_url'], font['notice_sha256']),
        ):
            target = output / directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(download(url, checksum, cache / checksum), target)
    shutil.copyfile(HOST / 'assets.json', output / 'licenses/font-sources.json')
    manifest = {
        'upstream': LOCK['source']['revision'],
        'ballons': LOCK['ballons']['revision'],
        'lock_sha256': sha256(ENGINE / 'mtu_engine/upstream.lock.json'),
        'files': {path.relative_to(output).as_posix(): sha256(path)
                  for directory in ('upstream', 'models', 'fonts', 'licenses', 'hyphenation')
                  for path in sorted((output / directory).rglob('*'))
                  if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc'},
    }
    (output / 'mtu-assets.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ENGINE / '.assets')
    parser.add_argument('--cache', type=Path, default=HOST / '.build/downloads')
    args = parser.parse_args()
    prepare(args.output, args.cache)
