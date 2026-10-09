"""Loopback membership preview: real SQLite catalog, no external payment/model calls.

Build website and admin-ui first, then run this file. All state is disposable.
"""
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def seed_models(db):
    from app.scheduler import lock_scheduler
    from app.translation_providers import ProviderWrite, write_provider
    lock_scheduler(db)
    # Deliberately non-operational upstream IDs/URL, for local routing acceptance only.
    for name, scopes in [('GPT 6 Luna', ['guest', 'free']), ('Haiku 5.5', ['plus', 'pro'])]:
        write_provider(db, ProviderWrite(name=name, channel='openai', text_plan_ids=scopes,
            title_weight=0, config={'model': name, 'base_url': 'https://membership-preview.invalid/v1'},
            api_key='local-preview-placeholder-not-a-real-key'))


def run():
    directory = Path(tempfile.mkdtemp(prefix='nc-membership-preview-'))
    port = int(os.environ.get('MEMBERSHIP_PREVIEW_PORT', '4322'))
    os.environ.update(APP_ENV='test', DEV_AUTH='true', DEV_ADMIN_USERNAME='admin',
        DEV_AUTH_SECRET='local-membership-preview-signing-secret-only',
        DATABASE_URL=f'sqlite:///{(directory / "preview.db").as_posix()}',
        STORAGE_PATH=str(directory / 'objects'), REDIS_NAMESPACE=directory.name,
        STRIPE_ENABLED='false', CREEM_ENABLED='false', CLASSIC_ENABLED='false',
        SERVE_STATIC='true', ADMIN_WEB_PATH='/console-preview/')
    from app.config import Settings
    Settings.model_config['env_file'] = None
    from fakeredis import FakeRedis
    from app import redis_state
    connection = FakeRedis(decode_responses=True)
    redis_state.client = lambda: connection
    from app.migrate import migrate
    from app.db import session_factory
    migrate()
    with session_factory()() as db:
        seed_models(db)
        db.commit()
    from app.main import app
    from app.website import WebsiteFiles
    from fastapi.responses import JSONResponse
    for route in app.routes:
        if getattr(route, 'name', None) == 'website':
            route.app = WebsiteFiles(Path(__file__).resolve().parents[1] / 'website' / 'dist')

    @app.middleware('http')
    async def local_only(request, call_next):
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and request.url.path.startswith((
                '/v1/billing/', '/v1/translation-requests', '/v1/comic-titles/', '/v1/guest/',
                '/v1/admin/translation-providers/')) and request.url.path.endswith(('/test', '/checkouts', '/sync', '/portal')):
            return JSONResponse({'error': {'code': 'LOCAL_PREVIEW',
                'message': '本地配置验收不调用支付平台或真实模型。'}}, status_code=409)
        response = await call_next(request)
        response.headers['X-Local-Preview'] = 'catalog-only-no-payments-or-models'
        return response

    print(f'Pricing: http://127.0.0.1:{port}/pricing/', flush=True)
    print(f'Admin: http://127.0.0.1:{port}/console-preview/ (username: admin)', flush=True)
    print('Isolated preview only; checkout and translation are disabled.', flush=True)
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=port, access_log=False, log_level='warning')


if __name__ == '__main__':
    run()
