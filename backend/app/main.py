from contextlib import asynccontextmanager
import re
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .storage import StorageError
from .errors import ProcessingError
from .redis_state import AdmissionUnavailable
from .translation_api import router as translation_router
from .guests import router as guest_router
from .comic_titles import TitleExecutor, router as comic_titles_router
from .analytics import router as analytics_router
from .compute_v3 import router as compute_v3_router
from .auth import bearer, identity, token_for, user_json
from .config import settings
from .db import get_db, session_factory
from .runtime import check_runtime
from .errors import problem
from .entitlements import entitlements_json
from .models import Ledger, User
from .providers import LANGUAGES
from .middleware import BodyLimitMiddleware
from .admin_api import router as admin_router
from .node_admin import router as node_admin_router
from .admin_monitor import router as admin_monitor_router
from .admin_audit import router as admin_audit_router
from .admin_operations import router as admin_operations_router
from .user_admin import router as user_admin_router
from .admin_web import create_router as create_admin_web_router
from .request_models import RequestBody
from .health import readiness, api_readiness
from .system_settings import router as system_settings_router
from .translation_providers import router as translation_providers_router
from .reader_api import router as reader_router
from .support_requests import router as support_requests_router
from .quota_grants import router as grants_router
from .quota_campaigns import router as campaigns_router
from .billing_api import router as billing_router
from .billing_admin import router as billing_admin_router
from .billing_catalog import router as billing_catalog_router
from .schemas import CapabilitiesResponse, EntitlementsResponse, LoginResponse, UsageResponse


@asynccontextmanager
async def lifespan(app):
    check_runtime()
    from .notifications import hub, close_hub
    hub().start()
    app.state.comic_title_executor = TitleExecutor()
    try:
        yield
    finally:
        app.state.comic_title_executor.close()
        close_hub()


app = FastAPI(title="Node Comics API", version="0.3.0", lifespan=lifespan, description="私有漫画图片、持久化翻译任务、普通与 PLUS 会员权益及周期页数额度。")
app.include_router(translation_router)
app.include_router(guest_router)
app.include_router(comic_titles_router)
app.include_router(analytics_router)
app.include_router(compute_v3_router)
app.include_router(reader_router)
app.include_router(support_requests_router)
app.include_router(grants_router)
app.include_router(campaigns_router)
app.include_router(billing_router)
app.include_router(billing_admin_router)
app.include_router(billing_catalog_router)
app.include_router(admin_monitor_router)
app.include_router(admin_audit_router)
app.include_router(admin_operations_router)
app.include_router(user_admin_router)
if settings().serve_static:
    app.include_router(create_admin_web_router(settings().admin_web_path))
app.include_router(system_settings_router)
app.include_router(translation_providers_router)
cfg = settings()
origins = [value.strip() for value in cfg.cors_origins.split(",") if value.strip()]
extension_ids = [value.strip() for value in cfg.extension_ids.split(",") if re.fullmatch(r"[a-p]{32}", value.strip())]
origins.extend(f"chrome-extension://{value}" for value in extension_ids)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=r"chrome-extension://[a-p]{32}" if cfg.dev_auth else None, allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Authorization", "X-Translation-Protocol", "Content-Type", "Idempotency-Key", "If-None-Match"], expose_headers=["Content-Disposition", "Retry-After", "ETag", "X-Request-ID"])
app.add_middleware(BodyLimitMiddleware)


@app.middleware("http")
async def request_guards(request: Request, call_next):
    from .models import uid
    request.state.request_id = uid()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if not getattr(request.state, 'public_website', False):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    code, message = 'INVALID_REQUEST', '请求字段不完整或格式无效，请检查标记字段'
    if request.url.path == '/v1/support-requests':
        code, message = 'SUPPORT_REQUEST_INVALID', '请检查网站名称、公开网址或反馈内容，以及字段长度。'
    elif any(item['type'] == 'language_unsupported' for item in exc.errors()):
        code, message = 'LANGUAGE_UNSUPPORTED', '此目标语言尚未开放，请选择支持的语言'
    elif request.url.path.startswith('/v1/admin/compute-nodes'):
        code, message = 'NODE_CONFIG_INVALID', '节点配置字段、数值或范围无效，请检查表单提示'
    return JSONResponse(status_code=422, content={'error': {'code': code, 'message': message,
        'fields': [{'path': '.'.join(str(part) for part in item['loc'] if part not in {'body', 'query', 'path'}),
                    'code': item['type']} for item in exc.errors()],
        'request_id': request.state.request_id}})


@app.exception_handler(HTTPException)
async def api_error(request, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "REQUEST_FAILED", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": {**detail, "request_id": request.state.request_id}}, headers=exc.headers)


@app.exception_handler(StorageError)
async def storage_error(request, exc):
    return JSONResponse(status_code=503, content={"error": {"code": exc.code, "message": "图片存储暂时不可用，请稍后重试", "request_id": request.state.request_id}})


@app.exception_handler(AdmissionUnavailable)
async def admission_error(request, exc):
    return JSONResponse(status_code=503, headers={'Retry-After': '2'}, content={'error': {
        'code': exc.code, 'message': '请求准入服务暂时不可用，请稍后重试', 'request_id': request.state.request_id}})


class DevLogin(RequestBody):
    username: str = Field(min_length=1, max_length=60, pattern=r"^[\w\-\u4e00-\u9fff ]+$")


def optional_identity(credentials=Depends(bearer), db: Session = Depends(get_db)):
    return identity(credentials, db) if credentials else None


@app.get("/health")
@app.get("/health/live")
def health():
    return {"status": "ok", "service": "node-comics", "version": "0.3.0", "release": settings().release_id}


@app.get("/health/ready")
def health_ready():
    payload, ready = api_readiness()
    return JSONResponse(status_code=200 if ready else 503, content=payload, headers={'Cache-Control': 'no-store'})


@app.get("/health/cluster")
def health_cluster():
    payload, ready = readiness()
    return JSONResponse(status_code=200 if ready else 503, content=payload)


@app.get("/v1/auth/config")
def auth_config():
    cfg = settings()
    return {"mode": "development" if cfg.dev_auth else "oidc", "dev_auth": cfg.dev_auth,
            "issuer": cfg.oidc_issuer, "client_id": cfg.oidc_client_id, "audience": cfg.oidc_audience,
            "authorization_endpoint": cfg.oidc_authorization_endpoint, "token_endpoint": cfg.oidc_token_endpoint,
            "scopes": "openid profile offline_access"}


@app.post("/v1/auth/dev", response_model=LoginResponse)
def dev_login(body: DevLogin, db: Session = Depends(get_db)):
    cfg = settings()
    if not cfg.dev_auth:
        problem("NOT_FOUND", "本地开发登录未开启", 404)
    name = body.username.strip()
    if not name:
        problem("INVALID_REQUEST", "请输入本地测试用户名", 422)
    subject = "dev:" + name.casefold()
    user = db.scalar(select(User).where(User.subject == subject))
    if not user:
        user = User(subject=subject, name=name, role="admin" if name.casefold() == cfg.dev_admin_username.casefold() else "user")
        db.add(user)
        try:
            db.flush()
            from .quota_campaigns import award_campaigns
            award_campaigns(db, user)
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.scalar(select(User).where(User.subject == subject))
    return {"access_token": token_for(user), "token_type": "bearer", "expires_in": 43200, "user": user_json(user)}


@app.get("/v1/me")
def me(user: User = Depends(identity), db: Session = Depends(get_db)):
    return {"user": user_json(user), "entitlements": entitlements_json(db, user)}


@app.get("/v1/me/entitlements", response_model=EntitlementsResponse)
def my_entitlements(user: User = Depends(identity), db: Session = Depends(get_db)):
    return entitlements_json(db, user)


@app.get("/v1/capabilities", response_model=CapabilitiesResponse)
def capabilities(db: Session = Depends(get_db), user: User | None = Depends(optional_identity)):
    cfg = settings()
    from .classic_config import enabled as classic_enabled
    entitlements = entitlements_json(db, user) if user else None
    from datetime import timedelta
    from .models import now
    from .queue_models import ComputeNode
    tiled = db.scalar(select(ComputeNode.id).where(ComputeNode.enabled.is_(True),
        ComputeNode.heartbeat_at > now() - timedelta(seconds=cfg.cluster_node_timeout_seconds),
        ComputeNode.runtime_report['overlay_tiles'].as_boolean().is_(True)).limit(1))
    return {"modes": [{"id": "classic", "label": "常规翻译", "enabled": classic_enabled(db,
                plan_id=entitlements['service_plan'] if entitlements else 'guest'), "languages": list(LANGUAGES)}],
            "languages": [{"id": key, "label": value} for key, value in LANGUAGES.items()],
            "representations": ['overlay-v1', 'full-image-v1', 'original'] + (['overlay-tiles-v1'] if tiled else []),
            # Retain the numeric field for existing clients; area is derived from the sole dimension ceiling.
            "limits": {"max_bytes": cfg.max_upload_bytes, "max_pixels": cfg.max_dimension ** 2, "max_dimension": cfg.max_dimension, "max_translation_ids": 32},
            "entitlements": entitlements,
            "unknown_release_seconds": cfg.unknown_release_seconds}


@app.get("/v1/me/usage", response_model=UsageResponse)
def usage(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(identity), db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Ledger).where(Ledger.owner_id == user.id))
    entries = db.scalars(select(Ledger).where(Ledger.owner_id == user.id).order_by(Ledger.created_at.desc()).offset(offset).limit(limit))
    return {"entitlements": entitlements_json(db, user), "items": [{"id": row.id, "job_id": row.job_id,
            "period_id": row.period_id, "quota_kind": row.quota_kind, "kind": row.kind, "pages": row.amount,
            "note": row.note, "created_at": row.created_at.isoformat() + "Z"} for row in entries],
            "total": total, "next_offset": offset + limit if offset + limit < total else None}


app.include_router(admin_router)
app.include_router(node_admin_router)


@app.exception_handler(ProcessingError)
async def processing_error(request, exc):
    status = 503 if exc.code == 'STORAGE_UNAVAILABLE' else 409 if exc.code in {"LEASE_EXPIRED", "NODE_CONFIG_CONFLICT"} else 422
    return JSONResponse(status_code=status, content={"error": {"code": exc.code, "message": exc.message, "request_id": request.state.request_id}})


# Describe the ASGI protocol gate on every generated translation operation,
# including routes included lazily by FastAPI.
_default_openapi = app.openapi


def translation_openapi():
    schema = _default_openapi()
    for path, operations in schema['paths'].items():
        if path != '/v1/translations' and not path.startswith('/v1/translations/'):
            continue
        for operation in operations.values():
            parameters = [item for item in operation.get('parameters', []) if item.get('name') != 'X-Translation-Protocol']
            operation['parameters'] = [*parameters, {
                'name': 'X-Translation-Protocol', 'in': 'header', 'required': True,
                'schema': {'type': 'string', 'enum': ['overlay-v1']},
                'description': 'Required on every translation resource; unsupported clients receive 409 CLIENT_UPGRADE_REQUIRED.'}]
    return schema


app.openapi = translation_openapi


# Keep this mount last: /v1, /internal, billing and the private admin entry win.
if settings().serve_static:
    from .website import WebsiteFiles
    app.mount('/', WebsiteFiles(), name='website')
