"""Isolated synthetic page executor for UI and deployment rehearsals only.

Uses real claims, cancellation fences, storage and settlement, but deliberately
bypasses OCR/text/render engines. It is not a compute-protocol integration test.
"""
from io import BytesIO
from threading import Event, Thread

from PIL import Image
from app.assets import create_asset, read_asset
from app.config import settings
from app.db import session_factory
from app.errors import ProcessingError
from app.languages import LANGUAGES
from app.models import Asset, now, uid
from app.queue_models import ComputeNode
from app.scheduler import claim_stage, current_lease, lock_scheduler, release_lease, touch_job
from app.workers import fail_stage, finish_job, finish_stopped_lease, _heartbeat


class SyntheticPageWorker:
    def __init__(self, output):
        assert settings().app_env == 'test', 'Synthetic workers require an isolated test environment'
        self.output, self.stopping = output, Event()
        self.node_id = 'fixture-' + uid()
        with session_factory()() as db:
            db.add(ComputeNode(id=self.node_id, name=self.node_id, resource_id=self.node_id,
                capabilities=['page'], capacity=1, engine_version='synthetic-test-v3', device='fixture',
                supported_languages=list(LANGUAGES), applied_config_version=1,
                runtime_report={'ready': True, 'protocol_version': 3}))
            db.commit()

    def run_once(self):
        with session_factory()() as db:
            lease = claim_stage(db, self.node_id, ['page'])
            db.commit()
            if lease is None:
                return False
            lease_id, token = lease.id, lease.token
            _, _, job = current_lease(db, lease_id, token)
            original = read_asset(db.get(Asset, job.input_asset_id))
        stopped = Event()
        heartbeat = Thread(target=_heartbeat, args=(lease_id, token, stopped), daemon=True)
        heartbeat.start()
        try:
            data = self.output(original)  # Never sleep or run synthetic work under the scheduler lock.
            if data is not None:
                image = Image.open(BytesIO(data)).convert('RGBA')
                buffer = BytesIO()
                image.save(buffer, 'WEBP', lossless=True)
                data, bbox = buffer.getvalue(), {'x': 0, 'y': 0, 'width': image.width, 'height': image.height}
            with session_factory()() as db:
                lock_scheduler(db)
                lease, stage, job = current_lease(db, lease_id, token)
                if data is not None:
                    output = create_asset(db, job.owner_id, data, kind='classic', parent_id=job.input_asset_id,
                        representation='overlay-v1', bbox=bbox, normalization_version=1)
                    job.output_asset_id = output.id
                stage.status, stage.completed_at = 'succeeded', now()
                finish_job(db, job, 'succeeded' if data is not None else 'no_text')
                release_lease(db, lease, 'succeeded')
                touch_job(db, job)
                db.commit()
        except ProcessingError as error:
            if error.code == 'LEASE_EXPIRED':
                finish_stopped_lease(lease_id, token)
            else:
                fail_stage(lease_id, error, token=token)
        finally:
            stopped.set()
            heartbeat.join(timeout=1)
        return True

    def run(self):
        try:
            while not self.stopping.is_set():
                if not self.run_once():
                    self.stopping.wait(.2)
        finally:
            with session_factory()() as db:
                db.get(ComputeNode, self.node_id).enabled = False
                db.commit()
