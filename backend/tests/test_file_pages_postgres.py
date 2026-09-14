"""Real DB serialization for simultaneous imports from different devices."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from threading import Barrier

from sqlalchemy import func, select

from test_postgres_concurrency import pg, pg_scope, pytestmark  # shared isolated DB fixtures


def test_two_devices_bind_identical_file_page_once(pg):
    from app.db import session_factory
    from app.file_pages import FilePage, FilePageIdentity, upload_file_page
    from app.models import Asset
    barrier = Barrier(4)
    source = FilePageIdentity(file_hash=sha256(b"test-container").hexdigest(), page_index=17)

    def upload(_):
        with session_factory()() as db:
            barrier.wait(timeout=10)
            asset = upload_file_page(db, pg["owner_id"], pg["png"], source)
            db.commit()
            return asset.id

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(upload, range(4)))
    assert len(set(results)) == 1
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(FilePage)) == 1
        # One original from the shared fixture and one new file identity.
        assert db.scalar(select(func.count()).select_from(Asset)) == 2
