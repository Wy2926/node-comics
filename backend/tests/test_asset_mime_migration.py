from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.models import Asset, Job, User
from app.overlay_tiles import MIME
from test_job_results_migration import migrate
from test_request_limits_migration import isolated_migration_database  # noqa: F401


def test_mime_upgrade_preserves_asset_parent_and_job_result_references(isolated_migration_database):
    engine = isolated_migration_database
    migrate(engine, 'hourly_image_limit_0011')
    with Session(engine) as db:
        db.add(User(id='mime-owner', subject='mime-owner', name='fixture'))
        db.flush()
        source = Asset(id='mime-input', owner_id='mime-owner', sha256='a' * 64, storage_key='inputs/mime-input/source',
            kind='original', mime='image/png', width=37, height=61, byte_size=100)
        db.add(source)
        db.flush()
        output = Asset(id='mime-output', owner_id=source.owner_id, parent_id=source.id, sha256='b' * 64,
            storage_key='results/mi/mime-output', kind='classic', mime='image/webp', width=3, height=4,
            byte_size=50, representation='overlay-v1', bbox={'x': 1, 'y': 2, 'width': 3, 'height': 4})
        db.add(output)
        db.flush()
        db.add(Job(id='mime-job', owner_id=source.owner_id, input_asset_id=source.id, output_asset_id=output.id,
            mode='classic', target_language='en', status='succeeded', phase='completed', idempotency_key='mime-request',
            operation='translation', request_hash='c' * 64, cache_key='d' * 64, config={}, quota_pages=1,
            quota_kind='classic_daily', settlement='settled', result_description={'representation': 'overlay-v1'}))
        db.commit()
    migrate(engine, 'head')
    columns = {column['name']: column for column in inspect(engine).get_columns('assets')}
    assert columns['mime']['type'].length == 128
    with Session(engine) as db:
        job, output = db.get(Job, 'mime-job'), db.get(Asset, 'mime-output')
        assert (job.input_asset_id, job.output_asset_id, job.settlement) == ('mime-input', 'mime-output', 'settled')
        assert output.parent_id == 'mime-input' and output.mime == 'image/webp'
        assert output.bbox == {'x': 1, 'y': 2, 'width': 3, 'height': 4}
        output.mime = MIME
        db.commit()
        assert db.get(Asset, output.id).mime == MIME
