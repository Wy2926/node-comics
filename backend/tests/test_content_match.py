"""Original-page content lookup across different comic containers, without billing."""
from hashlib import sha256
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from conftest import quota_usage, create, login_plus as login, upload
from test_file_pages import bind, complete, match, FILE_HASH


def source(png, file_hash="b"*64, index=9):
    return {"file_hash":file_hash,"page_index":index,"image_sha256":sha256(png).hexdigest()}


def test_repacked_page_recovers_without_mapping_upload_job_or_charge(client,png,monkeypatch):
    from app.db import session_factory
    from app.file_pages import FilePage
    from app.models import Asset, Job, Ledger
    auth=login(client)
    asset=bind(client,auth,png).json()["id"]
    job=complete(client,auth,asset,png,monkeypatch)
    before=quota_usage(client, auth)
    pages=[source(png),source(png,"c"*64,0)]
    result=match(client,login(client),pages)
    assert result.status_code==200,result.text
    for item,requested in zip(result.json()['items'],pages):
        assert item['file_hash']==requested['file_hash'] and item['page_index']==requested['page_index']
        assert item['asset']['id']==asset
        assert [j['id'] for j in item['jobs']]==[job['id']]
    assert quota_usage(client, auth)==before
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(FilePage))==1
        assert db.scalar(select(func.count()).select_from(Asset))==2
        assert db.scalar(select(func.count()).select_from(Job))==1
        assert db.scalar(select(func.count()).select_from(Ledger))==2


def test_content_match_is_private_and_uses_input_not_output_hash(client,png,monkeypatch):
    from conftest import png_variant
    auth=login(client)
    asset=upload(client,auth,png)  # Even historical images without FilePage can match.
    output=png_variant(png,7)
    complete(client,auth,asset,output,monkeypatch)
    assert match(client,auth,[source(png)]).json()['items'][0]['jobs']
    assert match(client,login(client,'bob'),[source(png)]).json()['items'][0]['asset'] is None
    assert match(client,auth,[source(output)]).json()['items'][0]['asset'] is None
    assert match(client,{},[source(png)]).status_code==401


@pytest.mark.parametrize('state',['deleted','expired'])
def test_content_fallback_never_returns_invalid_source(client,png,state):
    from app.db import session_factory
    from app.models import Asset,now
    auth=login(client);asset=bind(client,auth,png).json()['id']
    with session_factory()() as db:
        record=db.get(Asset,asset)
        if state=='deleted':record.deleted_at=now()
        elif state=='expired':record.expires_at=now()-timedelta(seconds=1)
        db.commit()
    assert match(client,auth,[source(png)]).json()['items'][0]['asset'] is None
    # A live duplicate cannot resurrect an already-invalid file mapping.
    upload(client,auth,png)
    assert match(client,auth,[source(png,FILE_HASH,0)]).json()['items'][0]['asset'] is None


def test_content_matching_uses_mode_language_config_and_preserves_unknown(client,png,monkeypatch):
    from app.config import settings
    from app.db import session_factory
    from app.models import Job
    auth=login(client);asset=bind(client,auth,png).json()['id']
    job=create(client,auth,asset).json()
    assert match(client,auth,[source(png)]).json()['items'][0]['jobs'][0]['id']==job['id']
    assert match(client,auth,[source(png)],language='en').json()['items'][0]['jobs']==[]
    with session_factory()() as db:
        db.get(Job,job['id']).status='outcome_unknown';db.commit()
    from app.db import session_factory
    from app.models import Provider
    with session_factory()() as db:
        provider=db.get(Provider,'default')
        provider.config={**provider.config,'model':'changed-image-model'}
        db.commit();settings.cache_clear()
    assert match(client,auth,[source(png)]).json()['items'][0]['jobs']==[]
    # Display restoration keeps unknown requests observable across config changes.
    result=client.post('/v1/file-pages/match',headers=auth,json={'pages':[source(png)],'mode':'redraw','target_language':'zh-Hans','include_display':True}).json()['items'][0]
    assert result['display_jobs'][0]['id']==job['id']
    alias=upload(client,auth,png)
    assert create(client,auth,alias,key='another-device').json()['id']==job['id']


def test_conflicting_and_invalid_client_hashes_cannot_bind_a_page(client,png):
    auth=login(client);bind(client,auth,png)
    wrong=source(png,FILE_HASH,0);wrong['image_sha256']='f'*64
    assert match(client,auth,[wrong]).json()['items'][0]['asset'] is None
    assert match(client,auth,[source(png,FILE_HASH,0),wrong]).status_code==422
    for value in ['bad','a'*32,17]:
        wrong['image_sha256']=value
        assert match(client,auth,[wrong]).status_code==422
    good=source(png);good['image_sha256']=good['image_sha256'].upper()
    assert match(client,auth,[good]).json()['items'][0]['asset'] is not None


def test_completed_submission_cache_hits_by_content_without_second_charge(client,png,monkeypatch):
    auth=login(client);asset=bind(client,auth,png).json()['id']
    job=complete(client,auth,asset,png,monkeypatch)
    before=quota_usage(client, auth)
    alias=bind(client,auth,png,file_hash='d'*64).json()['id']
    from conftest import submit_asset
    receipt=submit_asset(client,auth,alias,key='repacked').json()
    assert receipt['items'][0]['reused'] is True and receipt['quota_pages'] == 0
    cached=receipt['items'][0]['job']
    assert cached['id']==job['id']  # The submission item is reused; no new business job is billed.
    assert cached['output_asset_id']==job['output_asset_id']
    assert quota_usage(client, auth)==before
