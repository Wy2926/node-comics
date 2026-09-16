"""Isolated sandbox API (loopback 18766), public checkout/webhook only (18764).

Run with backend/.venv/Scripts/python.exe scripts/paddle_sandbox_server.py.
The Cloudflare tunnel must target 18764, never the development-auth API.
Credentials are read from the ignored .env.paddle.sandbox; no AI workers run.
"""
from pathlib import Path
import os
import secrets
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from paddle_sandbox_webhook import read_config

config = read_config(ROOT / '.env.paddle.sandbox')
if not config.get('PADDLE_CHECKOUT_URL'):
    config['PADDLE_CHECKOUT_URL'] = config['PADDLE_WEBHOOK_URL'].removesuffix('/webhooks/paddle') + '/billing/checkout'
directory = ROOT / 'artifacts' / 'paddle' / 'billing-runtime'
directory.mkdir(parents=True, exist_ok=True)
signing_file = directory / 'local-signing-key'
if not signing_file.exists():
    signing_file.write_text(secrets.token_urlsafe(48), encoding='utf-8')
os.environ.update({key: value for key, value in config.items() if key.startswith('PADDLE_')})
os.environ.update(APP_ENV='test', DEV_AUTH='true', PADDLE_ENABLED='true',
    DEV_AUTH_SECRET=signing_file.read_text(encoding='utf-8'),
    DATABASE_URL=f"sqlite:///{(directory / 'sandbox.sqlite').as_posix()}",
    STORAGE_PATH=str(directory / 'objects'), RESULT_STORAGE_BACKEND='local',
    R2_ENDPOINT_URL='', OPENAI_API_KEY='', PROVIDERS_JSON='', CLASSIC_ENABLED='false',
    CORS_ORIGINS='http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5174')
from app.config import Settings
Settings.model_config['env_file'] = None
from app.main import app
from app.billing_api import router
from app.billing_sync import reconcile_once
from app.db import initialize
from fastapi import FastAPI
import uvicorn

initialize()
public = FastAPI(docs_url=None, redoc_url=None, openapi_url=None,
                 exception_handlers=app.exception_handlers)
allowed = {'/webhooks/paddle', '/billing/checkout', '/billing/checkout.js',
           '/v1/billing/checkout-session', '/v1/billing/checkout-config'}
for route in router.routes:
    if getattr(route, 'path', '') in allowed:
        public.router.routes.append(route)


def reconcile():
    while True:
        try:
            reconcile_once()
        except Exception:
            # Durable rows remain pending; never print provider payloads or secrets.
            print('Sandbox billing reconciliation will retry', flush=True)
        time.sleep(5)


if __name__ == '__main__':
    threading.Thread(target=reconcile, daemon=True).start()
    threading.Thread(target=lambda: uvicorn.run(public, host='127.0.0.1', port=18764,
        access_log=False, log_level='warning'), daemon=True).start()
    print('Sandbox API: http://127.0.0.1:18766; checkout/webhook tunnel target: 18764', flush=True)
    uvicorn.run(app, host='127.0.0.1', port=18766, access_log=False, log_level='warning')
