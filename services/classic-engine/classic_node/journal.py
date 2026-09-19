"""Bounded local delivery journal. Claim IDs and payloads survive lost replies."""
import json
from pathlib import Path
import sqlite3
from threading import RLock


class Journal:
    def __init__(self, directory, limit):
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        self.process_lock = sqlite3.connect(root / 'owner.sqlite3', timeout=0)
        self.process_lock.execute('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)')
        self.process_lock.commit()
        self.process_lock.execute('BEGIN EXCLUSIVE')
        self.lock = RLock()
        self.db = sqlite3.connect(root / 'journal.sqlite3', check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('PRAGMA secure_delete=ON')
        self.db.execute('PRAGMA max_page_count=' + str(limit // 4096))
        self.db.execute('CREATE TABLE IF NOT EXISTS journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.db.commit()

    def get(self, key, default=None):
        with self.lock:
            row = self.db.execute('SELECT value FROM journal WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.lock, self.db:
            self.db.execute('INSERT OR REPLACE INTO journal VALUES (?,?)',
                            (key, json.dumps(value, ensure_ascii=True, allow_nan=False)))

    def remove(self, key):
        with self.lock, self.db:
            self.db.execute('DELETE FROM journal WHERE key=?', (key,))

    def leases(self):
        with self.lock:
            return {key.removeprefix('lease:'): json.loads(value)
                    for key, value in self.db.execute("SELECT key,value FROM journal WHERE key LIKE 'lease:%'")}

    def close(self):
        self.db.close()
        self.process_lock.close()
