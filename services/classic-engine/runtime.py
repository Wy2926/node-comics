"""One physical device admission lock and disposable bounded image cache.

The lock directory must be shared by engine processes on the same host. Images
never leave this engine cache and eviction is safe: render can rebuild from the
control service's validated OCR checkpoint and original object.
"""
import asyncio
from collections import OrderedDict
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import time


class DeviceLock:
    def __init__(self, resource, directory):
        self.path = Path(directory) / (hashlib.sha256(resource.encode()).hexdigest() + '.lock')
        self.local = asyncio.Lock()

    @asynccontextmanager
    async def hold(self):
        async with self.local:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = self.path.open('a+b')
            # Windows byte-range locks also cover bytes beyond EOF. Reading or
            # initializing byte zero before acquiring it races another process
            # and raises PermissionError when that process already holds it.
            acquired = False
            try:
                while not acquired:
                    try:
                        if os.name == 'nt':
                            import msvcrt
                            handle.seek(0)
                            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                    except (BlockingIOError, OSError):
                        await asyncio.sleep(0.05)
                yield
            finally:
                if acquired:
                    if os.name == 'nt':
                        import msvcrt
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                handle.close()


class ImageCache:
    """LRU encoded PNG bytes; no user images are written to disk."""
    def __init__(self, max_bytes, ttl_seconds):
        self.max_bytes = max(0, int(max_bytes))
        self.ttl_seconds = max(0, int(ttl_seconds))
        self.entries = OrderedDict()
        self.size = 0

    def _remove(self, key):
        value = self.entries.pop(key)
        self.size -= len(value[1])

    def expire(self):
        cutoff = time.monotonic() - self.ttl_seconds
        for key, (created, _) in list(self.entries.items()):
            if created <= cutoff:
                self._remove(key)

    def put(self, key, value):
        self.expire()
        if key in self.entries:
            self._remove(key)
        if len(value) > self.max_bytes or self.ttl_seconds == 0:
            return False
        while self.size + len(value) > self.max_bytes:
            self._remove(next(iter(self.entries)))
        self.entries[key] = (time.monotonic(), value)
        self.size += len(value)
        return True

    def get(self, key):
        self.expire()
        result = self.entries.get(key)
        if result is None:
            return None
        self.entries.move_to_end(key)
        return result[1]


def cache_key(scope, raw_hash, config, analysis):
    if not isinstance(scope, str) or not 1 <= len(scope) <= 128:
        raise ValueError('Invalid task scope')
    encoded = json.dumps([scope, raw_hash, config, analysis], sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    return hashlib.sha256(encoded).hexdigest()
