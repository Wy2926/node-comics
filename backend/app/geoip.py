"""Country lookup for a bounded admin page; no external requests or IP cache."""
from ipaddress import ip_address

import maxminddb

from .config import settings


def countries(addresses):
    result = {}
    public = set()
    for value in addresses:
        if not value:
            continue
        try:
            address = ip_address(value)
            if address.is_global:
                public.add(value)
            else:
                result[value] = {'code': None, 'status': 'private'}
        except ValueError:
            result[value] = {'code': None, 'status': 'unknown'}
    if not public:
        return result
    try:
        # mmap does not load the City database into Python memory. Open once per
        # page so an atomically replaced monthly database is used immediately.
        with maxminddb.open_database(settings().geoip_database, mode=maxminddb.MODE_MMAP) as reader:
            for address in public:
                record = reader.get(address) or {}
                code = record.get('country', {}).get('iso_code')
                valid = isinstance(code, str) and len(code) == 2 and code.isascii() and code.isalpha() and code.isupper()
                result[address] = {'code': code if valid else None, 'status': 'located' if valid else 'unknown'}
    except (OSError, ValueError, maxminddb.InvalidDatabaseError):
        result.update({address: {'code': None, 'status': 'unavailable'} for address in public})
    return result
