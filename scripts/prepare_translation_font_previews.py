"""Build offline, sample-only WOFF2 previews from checksum-pinned node fonts.

Run with: uv run --no-project --with 'fonttools[woff]==4.59.1' python
scripts/prepare_translation_font_previews.py --source artifacts/translation-fonts
The source directory must contain the original fonts and notices from assets.json.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, output):
    catalog = json.loads((ROOT / 'backend/shared/translation-fonts.json').read_text(encoding='utf-8'))
    assets = json.loads((ROOT / 'services/compute-node/assets.json').read_text(encoding='utf-8'))['fonts']
    assets = {font['id']: font for font in assets if 'id' in font}
    defaults = catalog['defaults']
    choices_by_id = {font['id']: font for font in catalog['fonts']}
    assert set(defaults) == set(catalog['samples']), 'Every target language needs one default font'
    for language, font_id in defaults.items():
        assert language in choices_by_id[font_id]['languages'], f'Unsupported default font: {language}'
    output.mkdir(parents=True, exist_ok=True)
    generated = []
    for choice in catalog['fonts']:
        asset = assets[choice['id']]
        assert asset['languages'] == choice['languages'], f"Language mismatch: {choice['id']}"
        assert set(choice['names']) == set(choice['languages']), f"Missing localized name: {choice['id']}"
        original, notice = source / asset['name'], source / asset['notice']
        for path, expected in ((original, asset['sha256']), (notice, asset['notice_sha256'])):
            if digest(path) != expected:
                raise ValueError(f'Pinned asset checksum mismatch: {path.name}')
        font = TTFont(original, recalcTimestamp=False)
        version = font['name'].getDebugName(5)
        characters = '0123456789 ' + ''.join(
            catalog['samples'][lang] + choice['names'][lang] for lang in choice['languages']
        )
        missing = set(map(ord, characters)) - font.getBestCmap().keys()
        if missing:
            raise ValueError(f"Preview would use fallback: {choice['id']} {sorted(missing)}")
        options = subset.Options()
        options.flavor = 'woff2'
        options.recalc_timestamp = False
        options.layout_features = ['*']
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
        options.name_languages = ['*']
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=characters)
        subsetter.subset(font)
        # Derived subsets get a new family name; original copyright, version,
        # license text and license URL stay in the name table and notice files.
        family = f"Node Comics Preview {choice['id']}"
        for record in font['name'].names:
            replacement = {1: family, 2: 'Regular', 3: family + '-1', 4: family,
                           6: family.replace(' ', '-'), 16: family, 17: 'Regular'}.get(record.nameID)
            if replacement:
                record.string = replacement.encode(record.getEncoding())
        font.flavor = 'woff2'
        target = output / (choice['id'] + '.woff2')
        font.save(target)
        font.close()
        shutil.copyfile(notice, output / notice.name)
        generated.append({**choice, 'file': target.name, 'sha256': digest(target), 'bytes': target.stat().st_size,
                          'source': asset['url'], 'source_sha256': asset['sha256'], 'source_version': version,
                          'license': asset['license'], 'notice': notice.name,
                          'notice_sha256': asset['notice_sha256']})
    (output / 'sources.json').write_text(json.dumps({'fonts': generated}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Both deployable Python packages carry their own small runtime catalog;
    # the browser catalog and checksum-pinned asset registry remain the source.
    choices = [{'id': font['id'], 'file': assets[font['id']]['name'], 'languages': font['languages'],
                'default_languages': [language for language, font_id in defaults.items() if font_id == font['id']]}
               for font in catalog['fonts']]
    for path, value in (
        (ROOT / 'services/classic-engine/mtu_engine/fonts.json', choices),
        (ROOT / 'backend/app/translation_fonts.json', {'fonts': [
            {'id': font['id'], 'languages': font['languages']} for font in choices], 'defaults': defaults}),
    ):
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'fonts': len(generated), 'woff2_bytes': sum(font['bytes'] for font in generated)}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'apps/extension/public/fonts/translation')
    args = parser.parse_args()
    prepare(args.source, args.output)
