"""Test-only supplier for the isolated deployment rehearsal; never deployed."""
from datetime import timedelta
from io import BytesIO
import json
import sys
import time

from PIL import Image, ImageDraw
from sqlalchemy import func, select
from app.config import settings
from app.db import session_factory
from app.models import Job, Ledger, User, now, uid
from app.redis_state import client, key

assert settings().app_env == 'test' and settings().redis_namespace.startswith('deploy-rehearsal-')


def synthetic(data, *args, **kwargs):
    from app.adapters.images import TranslationOutput
    client().incr(key('rehearsal-supplier-calls'))
    time.sleep(8)
    image = Image.open(BytesIO(data)).convert('RGB')
    ImageDraw.Draw(image).rectangle((10, 10, 90, 90), fill='#2177bb')
    output = BytesIO()
    image.save(output, 'PNG')
    return TranslationOutput(output.getvalue(), usage={'rehearsal': True})


if sys.argv[1:] == ['promote']:
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.subject == 'dev:rehearsal'))
        user.membership_id = uid()
        user.plus_started_at = now()
        user.plus_expires_at = now() + timedelta(days=30)
        user.plus_monthly_pages = 300
        db.commit()
elif sys.argv[1:] == ['stats']:
    with session_factory()() as db:
        print(json.dumps({'jobs': list(db.scalars(select(Job.status))),
            'ledger': dict(db.execute(select(Ledger.kind, func.sum(Ledger.amount)).group_by(Ledger.kind)).all()),
            'supplier_calls': int(client().get(key('rehearsal-supplier-calls')) or 0)}))
else:
    from app import workers
    workers.redraw = synthetic
    workers.main()
