"""Disposable local support UI fixture; no production database or external services.

Run: .venv/Scripts/python.exe tests/support_preview.py [--lose-first-response]
"""
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


if __name__ == '__main__':
    import uvicorn
    with TemporaryDirectory(prefix='node-comics-support-') as directory:
        os.environ.update(APP_ENV='test', DATABASE_URL='sqlite:///' + (Path(directory) / 'test.db').as_posix(),
            STORAGE_PATH=str(Path(directory) / 'objects'), RESULT_STORAGE_BACKEND='local',
            DEV_AUTH='true', DEV_AUTH_SECRET='isolated-support-preview-secret-not-for-production',
            DEV_ADMIN_USERNAME='admin', ADMIN_WEB_PATH='/console-fixture/',
            CORS_ORIGINS='http://127.0.0.1:5191', OPENAI_API_KEY='', PROVIDERS_JSON='[]',
            STRIPE_ENABLED='false', CREEM_ENABLED='false', CLASSIC_ENABLED='false')
        from app.config import Settings
        Settings.model_config['env_file'] = None
        from app.main import app
        if '--lose-first-response' in sys.argv:
            from fastapi.responses import JSONResponse
            lost = set()

            @app.middleware('http')
            async def lose_first_response(request, call_next):
                response = await call_next(request)
                if request.method == 'POST' and request.url.path == '/v1/support-requests' and response.status_code == 201:
                    key = request.headers.get('Idempotency-Key')
                    if key not in lost:
                        lost.add(key)
                        return JSONResponse(status_code=503, content={'error': {'code': 'FIXTURE_RESPONSE_LOST', 'message': '模拟：申请已保存，但首次响应丢失。请重试确认。'}})
                return response
        uvicorn.run(app, host='127.0.0.1', port=18089, proxy_headers=False, access_log=False)
