from contextlib import asynccontextmanager
import re
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .assets import access_json, delete_asset_object, object_path, owned_asset, record_user_access
from .storage import StorageError
from .errors import ProcessingError
from .scheduler import lock_scheduler, touch_job
from .translation_api import router as translation_router
from .comic_titles import TitleExecutor, router as comic_titles_router
from .compute_v2 import router as compute_v2_router
from .auth import bearer, identity, token_for, user_json
from .config import settings
from .db import get_db, initialize, session_factory
from .errors import problem
from .jobs import cancel_job
from .entitlements import entitlements_json
from .models import Asset, ClassicState, Job, Ledger, Provider, User, now
from .providers import LANGUAGES, credential, initialize_providers
from .languages import REDRAW_LANGUAGES
from .middleware import BodyLimitMiddleware
from .admin_api import router as admin_router
from .node_admin import router as node_admin_router
from .admin_monitor import router as admin_monitor_router
from .admin_audit import router as admin_audit_router
from .admin_operations import router as admin_operations_router
from .user_admin import router as user_admin_router
from .admin_web import create_router as create_admin_web_router
from .request_models import RequestBody
from .health import readiness
from .system_settings import initialize_system_settings, router as system_settings_router
from .translation_providers import router as translation_providers_router
from .file_pages import FilePageBinding, bind_translation_page, FilePageMatchRequest, FilePageMatches, match_file_pages
from .reader_api import router as reader_router
from .support_requests import router as support_requests_router
from .quota_grants import router as grants_router
from .billing_api import router as billing_router
from .billing_admin import router as billing_admin_router
from .billing_catalog import router as billing_catalog_router, initialize_catalog
from .schemas import AccessResponse, CapabilitiesResponse, EntitlementsResponse, LoginResponse, UsageResponse


@asynccontextmanager
async def lifespan(app):
    initialize()
    with session_factory()() as db:
        initialize_providers(db)
        from .control_pools import initialize_pools
        initialize_pools(db)
        initialize_system_settings(db)
        initialize_catalog(db)
        db.commit()
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
app.include_router(comic_titles_router)
app.include_router(compute_v2_router)
app.include_router(reader_router)
app.include_router(support_requests_router)
app.include_router(grants_router)
app.include_router(billing_router)
app.include_router(billing_admin_router)
app.include_router(billing_catalog_router)
app.include_router(admin_monitor_router)
app.include_router(admin_audit_router)
app.include_router(admin_operations_router)
app.include_router(user_admin_router)
app.include_router(create_admin_web_router(settings().admin_web_path))
app.include_router(system_settings_router)
app.include_router(translation_providers_router)
cfg = settings()
origins = [value.strip() for value in cfg.cors_origins.split(",") if value.strip()]
extension_ids = [value.strip() for value in cfg.extension_ids.split(",") if re.fullmatch(r"[a-p]{32}", value.strip())]
origins.extend(f"chrome-extension://{value}" for value in extension_ids)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=r"chrome-extension://[a-p]{32}" if cfg.dev_auth else None, allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "If-None-Match"], expose_headers=["Content-Disposition", "Retry-After", "ETag", "X-Request-ID"])
app.add_middleware(BodyLimitMiddleware)


@app.middleware("http")
async def request_guards(request: Request, call_next):
    from .models import uid
    request.state.request_id = uid()
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > (settings().cluster_max_result_bytes if request.url.path.startswith("/internal/") else settings().max_upload_bytes + 1024 * 1024):
        return JSONResponse(status_code=413, content={"error": {"code": "IMAGE_TOO_LARGE", "message": "请求图片超过上传限制", "request_id": request.state.request_id}})
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
    return JSONResponse(status_code=503, content={"error": {"code": "STORAGE_UNAVAILABLE", "message": "图片存储暂时不可用，请稍后重试", "request_id": request.state.request_id}})


class DevLogin(RequestBody):
    username: str = Field(min_length=1, max_length=60, pattern=r"^[\w\-\u4e00-\u9fff ]+$")


def optional_identity(credentials=Depends(bearer), db: Session = Depends(get_db)):
    return identity(credentials, db) if credentials else None


@app.get("/health")
@app.get("/health/live")
def health():
    return {"status": "ok", "service": "node-comics", "version": "0.3.0"}


@app.get("/health/ready")
def health_ready():
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
    redraw_enabled = any(credential(provider.config) for provider in db.scalars(select(Provider).where(Provider.enabled.is_(True))))
    from .classic_config import enabled as classic_enabled
    return {"modes": [{"id": "classic", "label": "常规翻译", "enabled": classic_enabled(db), "languages": list(LANGUAGES)},
                      {"id": "redraw", "label": "AI 重绘翻译", "enabled": redraw_enabled, "languages": REDRAW_LANGUAGES}],
            "languages": [{"id": key, "label": value} for key, value in LANGUAGES.items()],
            "limits": {"max_bytes": cfg.max_upload_bytes, "max_pixels": cfg.max_pixels, "max_dimension": cfg.max_dimension, "max_translation_ids": 32},
            "entitlements": entitlements_json(db, user) if user else None,
            "retention_days": cfg.retention_days, "unknown_release_seconds": cfg.unknown_release_seconds}


@app.put('/v1/file-pages/bind')
def file_page_bind(body: FilePageBinding, user: User = Depends(identity), db: Session = Depends(get_db)):
    return bind_translation_page(db, user.id, body)


@app.post("/v1/file-pages/match", response_model=FilePageMatches, response_model_exclude_unset=True)
def file_page_matches(body: FilePageMatchRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    return match_file_pages(db, user.id, body)


@app.get("/v1/images/{asset_id}/access", response_model=AccessResponse)
def image_access(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = owned_asset(db, asset_id, user.id)
    result = access_json(asset)
    record_user_access(db, asset)
    db.commit()
    return result


@app.get("/v1/images/{asset_id}/content")
def image_content(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = owned_asset(db, asset_id, user.id)
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[asset.mime]
    if asset.storage_backend != "local":
        result = RedirectResponse(access_json(asset)["url"], status_code=307)
        record_user_access(db, asset)
        db.commit()
        return result
    record_user_access(db, asset)
    db.commit()
    return FileResponse(object_path(asset.storage_key), media_type=asset.mime, filename=f"node-comics-{asset.id}.{extension}", content_disposition_type="inline")


@app.delete("/v1/images/{asset_id}")
def delete_image(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    from .results import ResultAccess
    from .translation_requests import TranslationRequest
    from sqlalchemy import update
    lock_scheduler(db)
    asset = db.get(Asset, asset_id)
    if not asset or asset.owner_id != user.id:
        problem("NOT_FOUND", "找不到此图片", 404)
    # Revoke this account's grants, including derived images and cached references.
    ids = {asset.id}
    if asset.kind == "original":
        ids.update(db.scalars(select(Asset.id).where(Asset.owner_id == user.id, Asset.parent_id == asset.id)))
        ids.update(value for value in db.scalars(select(Job.output_asset_id).where(Job.owner_id == user.id, Job.input_asset_id == asset.id)) if value)
    # Lock affected jobs before assets, matching completion's job -> asset lock order.
    affected_jobs = db.scalars(select(Job).where(Job.owner_id == user.id, or_(Job.input_asset_id.in_(ids), Job.output_asset_id.in_(ids))).order_by(Job.id).with_for_update(key_share=True)).all()
    if asset.kind == "original":
        ids.update(value for value in db.scalars(select(Job.output_asset_id).where(Job.owner_id == user.id, Job.input_asset_id == asset.id)) if value)
        ids.update(db.scalars(select(Asset.id).where(Asset.owner_id == user.id, Asset.parent_id == asset.id)))
    assets = db.scalars(select(Asset).where(Asset.id.in_(ids), Asset.owner_id == user.id).order_by(Asset.id).with_for_update(key_share=True)).all()
    affected_accesses = select(ResultAccess.id).where(ResultAccess.owner_id == user.id,
        or_(ResultAccess.input_asset_id.in_(ids), ResultAccess.output_asset_id.in_(ids)))
    db.execute(update(TranslationRequest).where(TranslationRequest.owner_id == user.id,
        or_(TranslationRequest.job_id.in_([job.id for job in affected_jobs]),
            TranslationRequest.access_id.in_(affected_accesses))).values(revoked_at=now()))
    for item in assets:
        item.deleted_at = item.deleted_at or now()
    for job in affected_jobs:
        cancel_job(db, job)
        touch_job(db, job)
        if asset.kind == 'original':
            state = db.get(ClassicState, job.id)
            if state:
                db.delete(state)
    for access in db.scalars(select(ResultAccess).where(ResultAccess.owner_id == user.id,
            or_(ResultAccess.input_asset_id.in_(ids), ResultAccess.output_asset_id.in_(ids)))):
        touch_job(db, access)
    db.commit()
    for item in assets:
        delete_asset_object(item)
        item.purged_at = now()
    db.commit()
    return {"deleted": True, "asset_ids": list(ids)}


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


# Keep this mount last: /v1, /internal, billing and the private admin entry win.
from .website import WebsiteFiles
app.mount('/', WebsiteFiles(), name='website')
