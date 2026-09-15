from conftest import quota_usage
from datetime import timedelta

import pytest
from sqlalchemy import event, select

from conftest import login_plus as login, upload


def seed_history(client, png, count=15):
    from app.batch_items import BatchItem
    from app.db import session_factory
    from app.models import Asset, Batch, Job, now
    auth = login(client)
    source_id = upload(client, auth, png)
    with session_factory()() as db:
        source = db.get(Asset, source_id)
        # Deliberately no stored bytes: summaries use database metadata only.
        output = Asset(owner_id=source.owner_id, parent_id=source.id, kind='classic',
                       storage_key='fixture/result', storage_backend='r2', sha256='a'*64,
                       mime='image/png', width=320, height=480, byte_size=1,
                       expires_at=now()+timedelta(days=1))
        db.add(output)
        db.flush()
        ids = []
        for n in range(count):
            batch = Batch(owner_id=source.owner_id, preview_id=f'preview-{n}', idempotency_key=f'batch-{n}',
                          request_hash='a'*64, quota_pages=1, created_at=now()+timedelta(seconds=n))
            db.add(batch)
            db.flush()
            job = Job(owner_id=source.owner_id, input_asset_id=source.id, output_asset_id=output.id,
                      batch_id=batch.id, ordinal=0, mode='classic', target_language='zh-Hans',
                      status='succeeded', settlement='settled', quota_kind='classic_daily', quota_pages=1, config={},
                      idempotency_key=f'job-{n}', operation='fixture', request_hash='a'*64, cache_key='b'*64)
            db.add(job)
            db.flush()
            db.add(BatchItem(batch_id=batch.id, ordinal=0, job_id=job.id, input_asset_id=source.id))
            ids.append(batch.id)
        db.commit()
        return auth, source_id, output.id, ids


def test_history_query_count_is_constant_and_pagination_is_complete(client, png, monkeypatch):
    from app.db import engine
    import app.assets as assets
    auth, _, _, ids = seed_history(client, png)
    monkeypatch.setattr(assets, 'get_store', lambda *args: pytest.fail('History accessed object storage'))
    statements = []
    def record(conn, cursor, statement, *args):
        statements.append(statement)
    event.listen(engine(), 'before_cursor_execute', record)
    try:
        small = client.get('/v1/translation-history?limit=1', headers=auth)
        assert small.status_code == 200
        small_count = len(statements)
        statements.clear()
        first = client.get('/v1/translation-history?limit=12', headers=auth).json()
        assert len(statements) == small_count == 4  # Identity + count + groups + projected rows.
        assert not any('jobs.config' in sql for sql in statements)
        assert [item['id'] for item in first['items']] == list(reversed(ids))[:12]
        assert first['total'] == 15 and first['next_offset'] == 12
        last = client.get('/v1/translation-history?offset=12&limit=12', headers=auth).json()
        assert len(last['items']) == 3 and last['next_offset'] is None
        assert client.get('/v1/translation-history?offset=99', headers=auth).json()['items'] == []
        assert client.get('/v1/translation-history', headers=login(client, 'bob')).json()['total'] == 0
    finally:
        event.remove(engine(), 'before_cursor_execute', record)


@pytest.mark.parametrize('target,field', [('source','deleted_at'), ('source','expires_at'),
                                         ('output','deleted_at'), ('output','expires_at'), ('output','purged_at')])
def test_history_expiry_is_database_authoritative(client, png, target, field):
    from app.db import session_factory
    from app.models import Asset, now
    auth, source, output, _ = seed_history(client, png, count=1)
    assert client.get('/v1/translation-history', headers=auth).json()['items'][0]['counts'] == {'succeeded':1}
    with session_factory()() as db:
        setattr(db.get(Asset, source if target == 'source' else output), field, now()-timedelta(seconds=1))
        db.commit()
    group = client.get('/v1/translation-history', headers=auth).json()['items'][0]
    assert group['counts'] == {'expired':1} and group['settled'] == 1


def test_history_duplicate_references_count_pages_but_charge_once(client, png):
    from app.batch_items import BatchItem
    from app.db import session_factory
    from app.models import Job
    auth, source, _, ids = seed_history(client, png, count=1)
    with session_factory()() as db:
        job = db.scalar(select(Job).where(Job.batch_id == ids[0]))
        job.quality_flags = ['unrecognized_regions']
        db.add(BatchItem(batch_id=ids[0], ordinal=1, job_id=job.id, input_asset_id=source))
        db.commit()
    group = client.get('/v1/translation-history', headers=auth).json()['items'][0]
    assert group['page_count'] == 2 and group['counts'] == {'partial':2}
    assert group['settled'] == 1 and group['asset_ids'] == [source, source]
