"""Explicit language dictionary download/verification, independent of GPU model setup."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request

from hyphenation import CATALOG, DictionaryStore, default_directory, language_list, resolve, resources, resource_path, verified


def download(record):
    url = f"https://raw.githubusercontent.com/LibreOffice/dictionaries/{CATALOG['revision']}/{record['path']}"
    request = urllib.request.Request(url, headers={'User-Agent': 'Node-Comics-Dictionary-Preparation/1'})
    # A fixed catalog controls source, maximum size, and expected bytes.
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read(record['bytes'] + 1)
    if len(raw) != record['bytes'] or hashlib.sha256(raw).hexdigest() != record['sha256']:
        raise RuntimeError('Dictionary resource checksum mismatch: ' + record['path'])
    return raw


def prepare(directory, languages, *, verify_only=False):
    requested = language_list(languages)
    if not requested:
        raise ValueError('Specify at least one language')
    locales = list(dict.fromkeys(resolve(value) for value in requested))
    checked, downloaded = set(), 0
    for locale in locales:
        if locale is None:
            continue
        for record in resources(locale):
            if record['path'] in checked:
                continue
            checked.add(record['path'])
            path = resource_path(directory, record)
            if verified(path, record):
                continue
            if verify_only:
                raise RuntimeError('Missing or corrupt dictionary resource: ' + record['path'])
            raw = download(record)
            # Validate again at the write boundary; never replace a valid file
            # with a truncated or unexpected response, even after a retry.
            if len(raw) != record['bytes'] or hashlib.sha256(raw).hexdigest() != record['sha256']:
                raise RuntimeError('Dictionary resource checksum mismatch: ' + record['path'])
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.download', delete=False) as target:
                    temporary = Path(target.name)
                    target.write(raw)
                temporary.replace(path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            downloaded += 1
    store = DictionaryStore(directory, requested)
    return {**store.describe(), 'directory': str(Path(directory).resolve()), 'downloaded_resources': downloaded,
            'verified_resources': len(checked), 'no_dictionary_needed': [value for value in requested if resolve(value) is None]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choices = parser.add_mutually_exclusive_group()
    choices.add_argument('--languages', nargs='+', help='Language tags, separated by spaces or commas; default: en')
    choices.add_argument('--all', action='store_true', help='Prepare every language in the pinned catalog')
    choices.add_argument('--list', action='store_true', help='List supported dictionary languages and licenses')
    parser.add_argument('--directory', type=Path, default=default_directory())
    parser.add_argument('--verify', action='store_true', help='Validate installed bytes without network access')
    args = parser.parse_args()
    if args.list:
        print(json.dumps({'version': CATALOG['version'], 'languages': {key: {'aliases': value['aliases'], 'license': value['license']}
            for key, value in CATALOG['dictionaries'].items()}, 'no_dictionary_needed': CATALOG['no_dictionary_languages']}, ensure_ascii=False, indent=2))
        return
    languages = list(CATALOG['dictionaries']) if args.all else args.languages or [os.environ.get('ENGINE_DICTIONARY_LANGUAGES', 'en')]
    try:
        print(json.dumps(prepare(args.directory, languages, verify_only=args.verify), ensure_ascii=False), flush=True)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'Dictionary preparation failed: {error}\n')


if __name__ == '__main__':
    main()
