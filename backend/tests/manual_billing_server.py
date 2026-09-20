"""Disposable catalog UI fixture. Stripe reads are synthetic; checkout never charges."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
directory = Path(tempfile.mkdtemp(prefix='nc-billing-ui-'))
os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_ADMIN_USERNAME='admin',
    DEV_AUTH_SECRET='isolated-billing-ui-secret-never-used-in-production',
    DATABASE_URL=f'sqlite:///{directory / "billing.db"}', STORAGE_PATH=str(directory / 'objects'),
    RESULT_STORAGE_BACKEND='local', STRIPE_ENABLED='true', STRIPE_ENVIRONMENT='test',
    STRIPE_SECRET_KEY='sk_test_synthetic', STRIPE_WEBHOOK_SECRET='whsec_synthetic',
    STRIPE_RETURN_URL='https://comics.example/account/', ADMIN_WEB_PATH='/console-test/')
from app.config import Settings
Settings.model_config['env_file'] = None
from app import stripe_client
from app.billing_models import BillingPrice
from app.db import session_factory


def synthetic(resource, action, *args, **kwargs):
    if (resource, action) != ('prices', 'retrieve'):
        raise stripe_client.BillingError('FIXTURE_NO_PAYMENT')
    from sqlalchemy import select
    with session_factory()() as db:
        price = db.scalar(select(BillingPrice).where(BillingPrice.stripe_price_id == args[0]))
    if not price or args[0] == 'price_error':
        raise stripe_client.BillingError('FIXTURE_PRICE_UNAVAILABLE')
    return {'id':price.stripe_price_id, 'product':price.stripe_product_id, 'livemode':False, 'active':True,
        'unit_amount':price.unit_amount, 'currency':price.currency,
        'recurring':{'interval':price.interval,'interval_count':1,'usage_type':'licensed'}}


stripe_client.call = synthetic
from app.main import app
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.environ.get('BILLING_FIXTURE_HOST','127.0.0.1'),
        port=int(os.environ.get('BILLING_FIXTURE_PORT','18091')), access_log=False, log_level='warning')
