"""Offline asset inventory and generated-directory upgrade checks; no models."""
import json
from pathlib import Path
import zipfile

import pytest

from mtu_engine.assets import LOCK, verify
from tools import prepare_mtu


@pytest.mark.parametrize('ocr_backend', ['classic', 'hayai'])
def test_prepare_removes_retired_generated_assets_but_preserves_samples_and_cache(tmp_path, monkeypatch, ocr_backend):
    output, cache = tmp_path / 'prepared', tmp_path / 'download-cache'
    stale = ('models/retired/weights.bin', 'upstream/retired/module.py',
             'upstream/retired/LICENSE', 'licenses/retired-model.txt',
             'fonts/RetiredFont.ttf', 'licenses/RetiredFont-OFL.txt')
    for name in stale:
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'old generated asset')
    sample = output / 'samples/private-page.png'
    sample.parent.mkdir()
    sample.write_bytes(b'private user sample')
    cache.mkdir()
    cached_sample = cache / 'kept-cache-entry'
    cached_sample.write_bytes(b'existing cache content')

    host = tmp_path / 'build-host'
    host.mkdir()
    (host / 'assets.json').write_text(json.dumps({'fonts': [{
        'name': 'Test.ttf', 'url': 'font', 'sha256': 'font-digest',
        'notice': 'Test-LICENSE.txt', 'notice_url': 'font-license', 'notice_sha256': 'notice-digest',
    }]}), encoding='utf-8')
    monkeypatch.setattr(prepare_mtu, 'HOST', host)
    archives = {}
    for key, repository, modules in (
        ('source', 'manga-translator-ui', ('manga_translator',)),
        ('ballons', 'BallonsTranslator', ('ballontranslator', 'resources')),
        ('comic_translate', 'comic-translate', ('modules', 'imkit')),
    ):
        source = LOCK[key]
        prefix = repository + '-' + source['revision'] + '/'
        entries = {prefix + name + '/__init__.py': '' for name in modules}
        entries[prefix + 'LICENSE'] = 'retained source license'
        if 'patches' in source:
            entries.update({prefix + name: ''.join(patch['before'] for patch in patches)
                            for name, patches in source['patches'].items()})
        archives[source['url']] = entries
    archives[LOCK['hyphenation']['url']] = {
        'pyphen/dictionaries/hyph_en_US.dic': 'UTF-8\n',
        'pyphen/dictionaries/README_en_US.txt': 'retained dictionary notice',
    }
    def download(url, checksum, target):
        target = Path(target)
        if url in archives:
            with zipfile.ZipFile(target, 'w') as package:
                for name, contents in archives[url].items():
                    package.writestr(name, contents)
        else:
            target.write_bytes(b'prepared test asset')
        return target

    monkeypatch.setattr(prepare_mtu, 'download', download)
    manifest = prepare_mtu.prepare(output, cache, ocr_backend)
    assert verify(output / 'models', ocr_backend) == manifest
    assert all(not (output / name).exists() for name in stale)
    assert {path.name for path in (output / 'fonts').iterdir()} == {'Test.ttf'}
    assert sample.read_bytes() == b'private user sample'
    assert cached_sample.read_bytes() == b'existing cache content'
    for name in ('upstream/manga_ocr/LICENSE', 'upstream/mot/LICENSE',
                 'models/ocr/ch_PP-OCRv5_rec_mobile_infer.onnx', 'models/manga/pytorch_model.bin'):
        assert (name in manifest['files']) == (ocr_backend == 'classic')
    assert 'models/ocr/ocr_ar_48px.ckpt' in manifest['files']
    assert 'models/ocr/alphabet-all-v7.txt' in manifest['files']
    assert not any(name.startswith('samples/') for name in manifest['files'])


@pytest.mark.parametrize('marker', ['node.json', 'state'])
def test_prepare_rejects_node_state_before_removing_generated_files(tmp_path, marker):
    (tmp_path / marker).write_bytes(b'node state')
    original = tmp_path / 'models/keep.bin'
    original.parent.mkdir()
    original.write_bytes(b'untouched')
    with pytest.raises(ValueError, match='configured node state'):
        prepare_mtu.prepare(tmp_path, tmp_path / 'cache')
    assert original.read_bytes() == b'untouched'
