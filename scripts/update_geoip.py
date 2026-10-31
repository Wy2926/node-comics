"""Update the admin API's local DB-IP Lite City database, independently of analytics."""
import argparse
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import urllib.request


def update(directory, *, month=None):
    import maxminddb

    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o755)
    target = directory / 'city.mmdb'
    manifest = directory / 'sources.json'
    month = month or datetime.now().strftime('%Y-%m')
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    if target.exists():
        target.chmod(0o644)
        if previous.get('month') == month:
            print('GeoIP database already current')
            return
    temporary = directory / '.city.tmp'
    manifest_temporary = directory / '.sources.tmp'
    url = f'https://download.db-ip.com/free/dbip-city-lite-{month}.mmdb.gz'
    digest = hashlib.sha256()
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'NodeLane-GeoIP/1.0',
                                                       'Referer': 'https://db-ip.com/'})
        with urllib.request.urlopen(request, timeout=60) as response, gzip.GzipFile(fileobj=response) as reader, temporary.open('wb') as writer:
            while chunk := reader.read(1024 * 1024):
                writer.write(chunk)
                digest.update(chunk)
        with maxminddb.open_database(str(temporary)) as database:
            if 'city' not in database.metadata().database_type.lower():
                raise RuntimeError('Unexpected GeoIP database type')
            database.get('8.8.8.8')
        temporary.chmod(0o644)
        temporary.replace(target)
        sources = {'city': {'url': url, 'sha256': digest.hexdigest(), 'bytes': target.stat().st_size}}
        manifest_temporary.write_text(json.dumps({'month': month, 'license': 'CC-BY-4.0',
            'attribution': 'https://db-ip.com/', 'sources': sources}, indent=2), encoding='utf-8')
        manifest_temporary.chmod(0o644)
        manifest_temporary.replace(manifest)
        print(json.dumps({'geoip_month': month, 'sources': sources}))
    finally:
        temporary.unlink(missing_ok=True)
        manifest_temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/var/lib/nodelane-geoip'))
    update(parser.parse_args().directory)
