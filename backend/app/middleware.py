"""Limit bytes at ASGI receive, including chunked multipart before disk spooling."""
from fastapi.responses import JSONResponse
from fastapi import HTTPException
from .config import settings


class BodyLimitExceeded(HTTPException):
    def __init__(self):
        super().__init__(413, detail={"code": "IMAGE_TOO_LARGE", "message": "请求超过上传限制"})


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get('path', '')
        headers = dict(scope.get('headers', []))
        translation_path = path == '/v1/translations' or path.startswith('/v1/translations/') or path.startswith('/v1/guest/translations')
        if scope.get('method') != 'OPTIONS' and translation_path:
            if headers.get(b'x-translation-protocol') != b'overlay-v1':
                response = JSONResponse(status_code=409, content={'error': {
                    'code': 'CLIENT_UPGRADE_REQUIRED',
                    'message': '请安装 0.8.0 或更新版本：https://comics.nodelane.net/download/。',
                    'update_url': 'https://comics.nodelane.net/download/'}})
                return await response(scope, receive, send)
        consumed = 0
        started = False
        limit = settings().cluster_max_result_bytes if scope.get("path", "").startswith("/internal/") else settings().max_upload_bytes + 1024 * 1024
        if (translation_path or path.startswith('/v1/guest/')) and not path.endswith('/input'):
            limit = settings().translation_max_body_bytes
        if scope.get('path') == '/v1/support-requests':
            limit = 16384
        if scope.get('path', '').startswith('/internal/compute/v3/leases/') and scope['path'].endswith('/analysis'):
            limit = 4 * 1024 * 1024 + 4096

        if scope.get('path', '').startswith('/internal/compute/v3/leases/') and scope['path'].endswith('/result'):
            limit = settings().cluster_max_result_bytes + 65536 + 4096

        length = headers.get(b'content-length', b'')
        if length.isdigit() and int(length) > limit:
            response = JSONResponse(status_code=413, content={'error': {
                'code': 'IMAGE_TOO_LARGE', 'message': '请求超过上传限制'}})
            return await response(scope, receive, send)

        async def bounded_receive():
            nonlocal consumed
            message = await receive()
            consumed += len(message.get("body", b""))
            if consumed > limit:
                raise BodyLimitExceeded()
            return message

        async def tracked_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, bounded_receive, tracked_send)
        except BodyLimitExceeded:
            if not started:
                response = JSONResponse(status_code=413, content={"error": {"code": "IMAGE_TOO_LARGE", "message": "请求超过上传限制"}})
                await response(scope, receive, send)
