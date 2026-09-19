"""Operation history returns account-local per-image receipts without object probes."""
from datetime import timedelta
import pytest
from sqlalchemy import event,select
from conftest import login_plus as login,upload


def seed_history(client,png,count=15):
    from app.plan_models import TranslationOperation
    from app.db import session_factory
    from app.models import Asset,Job,now
    auth=login(client)
    source_id=upload(client,auth,png)
    with session_factory()() as db:
        source=db.get(Asset,source_id)
        source.storage_backend="r2"
        output=Asset(owner_id=source.owner_id,parent_id=source.id,kind='classic',
                     storage_key='fixture/result',storage_backend='r2',sha256='a'*64,
                     mime='image/png',width=320,height=480,byte_size=1,expires_at=now()+timedelta(days=1))
        db.add(output);db.flush()
        keys=[]
        for index in range(count):
            job=Job(owner_id=source.owner_id,input_asset_id=source.id,output_asset_id=output.id,
                source_sha256=source.sha256,mode='classic',target_language='zh-Hans',
                status='succeeded',settlement='settled',quota_kind='classic_daily',quota_pages=1,config={},
                idempotency_key=f'job-{index}',operation='fixture',request_hash='a'*64,cache_key='b'*64)
            db.add(job);db.flush()
            key=f'operation-{index}'
            db.add(TranslationOperation(owner_id=source.owner_id,operation_key=key,request_hash='a'*64,
                job_id=job.id,descriptor={'client_item_id':str(index)},created_at=now()+timedelta(seconds=index)))
            keys.append(key)
        db.commit()
        return auth,source_id,output.id,keys


def test_history_paginates_every_operation_without_object_storage(client,png,monkeypatch):
    import app.assets as assets
    auth,_,_,keys=seed_history(client,png)
    monkeypatch.setattr(assets,'get_store',lambda *args:pytest.fail('History accessed object storage'))
    first=client.get('/v1/translation-operations?limit=12',headers=auth)
    assert first.status_code==200,first.text
    data=first.json()
    assert [item['operation_key'] for item in data['items']]==list(reversed(keys))[:12]
    assert data['total']==15 and data['next_offset']==12
    last=client.get('/v1/translation-operations?offset=12&limit=12',headers=auth).json()
    assert len(last['items'])==3 and last.get('next_offset') is None
    assert client.get('/v1/translation-operations?offset=99',headers=auth).json()['items']==[]
    assert client.get('/v1/translation-operations',headers=login(client,'bob')).json()['total']==0


@pytest.mark.parametrize('target,field',[('source','deleted_at'),('source','expires_at'),
    ('output','deleted_at'),('output','expires_at'),('output','purged_at')])
def test_history_never_exposes_expired_result_as_ready(client,png,target,field):
    from app.db import session_factory
    from app.models import Asset,now
    auth,source,output,_=seed_history(client,png,count=1)
    assert client.get('/v1/translation-operations',headers=auth).json()['items'][0]['disposition']=='ready'
    with session_factory()() as db:
        setattr(db.get(Asset,source if target=='source' else output),field,now()-timedelta(seconds=1))
        db.commit()
    item=client.get('/v1/translation-operations',headers=auth).json()['items'][0]
    assert item['disposition']=='blocked'
    assert item['job'].get('output_asset_id') is None


def test_alias_operations_share_job_without_changing_settlement(client,png):
    from app.plan_models import TranslationOperation
    from app.db import session_factory
    from app.models import Job
    auth,_,_,keys=seed_history(client,png,count=1)
    with session_factory()() as db:
        original=db.scalar(select(TranslationOperation))
        job=db.get(Job,original.job_id)
        db.add(TranslationOperation(owner_id=original.owner_id,operation_key='alias',request_hash='c'*64,
            job_id=job.id,descriptor={'client_item_id':'alias'}))
        db.commit()
    data=client.get('/v1/translation-operations',headers=auth).json()
    assert data['total']==2 and len({item['job']['id'] for item in data['items']})==1
    assert all(item['job']['settlement']=='settled' for item in data['items'])


def test_history_query_count_does_not_grow_with_page_size(client,png):
    from app.db import engine
    auth,_,_,_=seed_history(client,png)
    statements=[]
    def record(conn,cursor,statement,*args):
        if statement.lstrip().upper().startswith('SELECT'):statements.append(statement)
    # Warm independent HTTP protection before comparing page sizes.
    assert client.get('/v1/translation-operations?limit=1',headers=auth).status_code==200
    event.listen(engine(),'before_cursor_execute',record)
    try:
        small=client.get('/v1/translation-operations?limit=1',headers=auth)
        assert small.status_code==200
        small_count=len(statements)
        statements.clear()
        large=client.get('/v1/translation-operations?limit=12',headers=auth)
        assert large.status_code==200 and len(large.json()['items'])==12
        assert len(statements)==small_count
    finally:event.remove(engine(),'before_cursor_execute',record)
