"""Test-only page executor for the isolated deployment rehearsal; never deployed."""
from datetime import timedelta
from io import BytesIO
import json
import sys
import time
from threading import Thread

from PIL import Image, ImageDraw
from sqlalchemy import func, select
from app.config import settings
from app.db import session_factory
from app.models import Job, Ledger, User, now, uid
from app.redis_state import client, key

assert settings().app_env == 'test' and settings().redis_namespace.startswith('deploy-rehearsal-')


def synthetic(data, *args, **kwargs):
    client().incr(key('rehearsal-supplier-calls'))
    time.sleep(8)
    image = Image.open(BytesIO(data)).convert('RGB')
    ImageDraw.Draw(image).rectangle((10, 10, 90, 90), fill='#2177bb')
    output = BytesIO()
    image.save(output, 'PNG')
    return output.getvalue()


if sys.argv[1:] == ['promote']:
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject == 'dev:rehearsal'))
        user.membership_id = uid()
        user.plus_started_at = now()
        user.plus_expires_at = now() + timedelta(days=30)
        user.plus_monthly_pages = 300
        from app.translation_providers import ProviderWrite, write_provider
        from app.scheduler import lock_scheduler
        lock_scheduler(db)
        write_provider(db, ProviderWrite(name='Rehearsal text routing', channel='openai',
            config={'model': 'synthetic-test', 'base_url': 'https://text.invalid/v1'},
            api_key='synthetic-test-only'))
        db.commit()
elif sys.argv[1:] == ['stats']:
    with session_factory()() as db:
        print(json.dumps({'jobs': list(db.scalars(select(Job.status))),
            'ledger': dict(db.execute(select(Ledger.kind, func.sum(Ledger.amount)).group_by(Ledger.kind)).all()),
            'supplier_calls': int(client().get(key('rehearsal-supplier-calls')) or 0)}))
else:
    from app import workers
    from classic_fixture_worker import SyntheticPageWorker
    from types import SimpleNamespace
    page_worker = SyntheticPageWorker(synthetic)
    thread = Thread(target=page_worker.run)
    thread.start()
    register_signal = workers.signal.signal
    def register_stop(name, handler):
        def stop(*args):
            page_worker.stopping.set()
            handler(*args)
        register_signal(name, stop)
    workers.signal = SimpleNamespace(SIGTERM=workers.signal.SIGTERM, SIGINT=workers.signal.SIGINT,
                                     signal=register_stop)
    try:
        workers.main()
    finally:
        page_worker.stopping.set()
        thread.join()
