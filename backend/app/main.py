from contextlib import asynccontextmanager
from datetime import timedelta
import re
from typing import Annotated, Literal
from fastapi import Depends, FastAPI, File, Form, Header, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .assets import asset_json, available, create_asset, object_path, owned_asset
from .auth import admin, bearer, identity, token_for
from .config import settings
from .db import get_db, initialize, session_factory
from .errors import problem
from .jobs import batch_status, cancel_job, create_batch, create_job, create_quote, idem_key, job_json, owned_job, quota_json, quote_json, settle
from .models import Asset, Attempt, Batch, ClassicState, Job, Ledger, Provider, TextCall, User, now
from .providers import LANGUAGES, ProviderConfig, configuration, credential, initialize_providers
from .middleware import BodyLimitMiddleware
from .schemas import AccessResponse, AssetResponse, BatchCreatedResponse, BatchResponse, CapabilitiesResponse, JobPageResponse, JobResponse, JobsResponse, LoginResponse, QuoteResponse, UsageResponse


@asynccontextmanager
async def lifespan(app):
    initialize()
    with session_factory()() as db:
        initialize_providers(db)
    yield


app = FastAPI(title="Node Comics API", version="0.1.0", lifespan=lifespan, description="私有漫画图片、持久化翻译任务和测试额度。图片通过 Bearer 授权网关读取。")
cfg = settings()
origins = [value.strip() for value in cfg.cors_origins.split(",") if value.strip()]
extension_ids = [value.strip() for value in cfg.extension_ids.split(",") if re.fullmatch(r"[a-p]{32}", value.strip())]
origins.extend(f"chrome-extension://{value}" for value in extension_ids)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=r"chrome-extension://[a-p]{32}" if cfg.dev_auth else None, allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key"], expose_headers=["Content-Disposition"])
app.add_middleware(BodyLimitMiddleware)


@app.middleware("http")
async def request_guards(request: Request, call_next):
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > settings().max_upload_bytes + 1024 * 1024:
        return JSONResponse(status_code=413, content={"error": {"code": "IMAGE_TOO_LARGE", "message": "请求图片超过上传限制"}})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST", "message": "请求字段不完整或格式无效，请检查图片和所选范围"}})


from fastapi import HTTPException


@app.exception_handler(HTTPException)
async def api_error(request, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "REQUEST_FAILED", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DevLogin(Body):
    username: str = Field(min_length=1, max_length=60, pattern=r"^[\w\-\u4e00-\u9fff ]+$")


class StatusRequest(Body):
    ids: list[str] = Field(min_length=1, max_length=100)


class QuoteRequest(Body):
    asset_ids: list[str] = Field(min_length=1, max_length=100)
    mode: Literal["redraw", "classic"]
    target_language: str


class BatchRequest(Body):
    quote_id: str
    max_credits: int = Field(ge=0, le=1_000_000)


class RerunRequest(Body):
    quote_id: str
    max_credits: int = Field(ge=0, le=1_000_000)
    acknowledge_unknown_cost: bool = False


class QuotaAdjustment(Body):
    amount: int = Field(ge=-1_000_000, le=1_000_000)
    note: str = Field(default="运营测试额度", max_length=200)


class ProviderToggle(Body):
    enabled: bool


class ReconcileRequest(Body):
    resolution: Literal["failed", "succeeded"]
    output_asset_id: str | None = None
    note: str = Field(min_length=1, max_length=200)


def optional_identity(credentials=Depends(bearer), db: Session = Depends(get_db)):
    return identity(credentials, db) if credentials else None


def user_json(user):
    return {"id": user.id, "name": user.name, "role": user.role}


@app.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"status": "ok", "service": "node-comics", "version": "0.1.0"}


@app.get("/v1/auth/config")
def auth_config():
    cfg = settings()
    return {"mode": "development" if cfg.dev_auth else "oidc", "dev_auth": cfg.dev_auth,
            "issuer": cfg.oidc_issuer, "client_id": cfg.oidc_client_id, "audience": cfg.oidc_audience,
            "authorization_endpoint": cfg.oidc_authorization_endpoint, "token_endpoint": cfg.oidc_token_endpoint,
            "scopes": "openid profile"}


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
        user = User(subject=subject, name=name, role="admin" if name.casefold() == cfg.dev_admin_username.casefold() else "user", balance=cfg.initial_quota)
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.scalar(select(User).where(User.subject == subject))
    return {"access_token": token_for(user), "token_type": "bearer", "expires_in": 43200, "user": user_json(user)}


@app.get("/v1/me")
def me(user: User = Depends(identity)):
    return {"user": user_json(user), "quota": quota_json(user)}


@app.get("/v1/capabilities", response_model=CapabilitiesResponse)
def capabilities(db: Session = Depends(get_db), user: User | None = Depends(optional_identity)):
    cfg = settings()
    redraw_enabled = any(credential(provider.config) for provider in db.scalars(select(Provider).where(Provider.enabled.is_(True))))
    from .classic_config import enabled as classic_enabled
    return {"modes": [{"id": "classic", "label": "常规翻译", "enabled": classic_enabled(), "unit_cost": cfg.classic_cost, "languages": list(LANGUAGES)},
                      {"id": "redraw", "label": "AI 重绘翻译", "enabled": redraw_enabled, "unit_cost": cfg.redraw_cost, "languages": list(LANGUAGES)}],
            "languages": [{"id": key, "label": value} for key, value in LANGUAGES.items()],
            "limits": {"max_bytes": cfg.max_upload_bytes, "max_pixels": cfg.max_pixels, "max_dimension": cfg.max_dimension, "max_batch": cfg.max_batch, "max_active_jobs": cfg.max_active_jobs},
            "quota": quota_json(user) if user else None, "retention_days": cfg.retention_days, "unknown_release_seconds": cfg.unknown_release_seconds,
            "pricing_version": "test-credits-v1", "pricing_note": "测试额度按成功交付页面计量；不是现金价格"}


async def upload_bytes(image):
    data = await image.read(settings().max_upload_bytes + 1)
    await image.close()
    return data


@app.post("/v1/images", status_code=201, response_model=AssetResponse)
async def upload_image(image: Annotated[UploadFile, File()], user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = create_asset(db, user.id, await upload_bytes(image))
    db.commit()
    return asset_json(asset)


@app.get("/v1/images/{asset_id}/access", response_model=AccessResponse)
def image_access(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = owned_asset(db, asset_id, user.id)
    return {"url": f"/v1/images/{asset.id}/content", "expires_at": asset.expires_at.isoformat() + "Z", "authorization_required": True}


@app.get("/v1/images/{asset_id}/content")
def image_content(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = owned_asset(db, asset_id, user.id)
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[asset.mime]
    return FileResponse(object_path(asset.storage_key), media_type=asset.mime, filename=f"node-comics-{asset.id}.{extension}", content_disposition_type="inline")


@app.delete("/v1/images/{asset_id}")
def delete_image(asset_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    asset = db.get(Asset, asset_id)
    if not asset or asset.owner_id != user.id:
        problem("NOT_FOUND", "找不到此图片", 404)
    # Persist tombstones before unlinking. Include derived images and cached references.
    ids = {asset.id}
    if asset.kind == "original":
        ids.update(db.scalars(select(Asset.id).where(Asset.owner_id == user.id, Asset.parent_id == asset.id)))
        ids.update(value for value in db.scalars(select(Job.output_asset_id).where(Job.owner_id == user.id, Job.input_asset_id == asset.id)) if value)
    # Lock affected jobs before assets, matching completion's job -> asset lock order.
    affected_jobs = db.scalars(select(Job).where(Job.owner_id == user.id, or_(Job.input_asset_id.in_(ids), Job.output_asset_id.in_(ids))).order_by(Job.id).with_for_update()).all()
    if asset.kind == "original":
        ids.update(value for value in db.scalars(select(Job.output_asset_id).where(Job.owner_id == user.id, Job.input_asset_id == asset.id)) if value)
        ids.update(db.scalars(select(Asset.id).where(Asset.owner_id == user.id, Asset.parent_id == asset.id)))
    assets = db.scalars(select(Asset).where(Asset.id.in_(ids), Asset.owner_id == user.id).with_for_update()).all()
    for item in assets:
        item.deleted_at = item.deleted_at or now()
    for job in affected_jobs:
        cancel_job(db, job)
        if asset.kind == 'original':
            state = db.get(ClassicState, job.id)
            if state:
                db.delete(state)
    db.commit()
    for item in assets:
        object_path(item.storage_key).unlink(missing_ok=True)
        item.purged_at = now()
    db.commit()
    return {"deleted": True, "asset_ids": list(ids)}


@app.get('/v1/jobs/{job_id}/classic')
def classic_details(job_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    job = owned_job(db, job_id, user.id)
    owned_asset(db, job.input_asset_id, user.id)
    if job.mode != 'classic':
        problem('MODE_UNSUPPORTED', '此任务没有常规翻译数据', 422)
    state = db.get(ClassicState, job.id)
    if not state:
        return {'segments': [], 'translations': {}, 'artifacts': {}, 'timings': {}}
    return {'segments': (state.analysis or {}).get('segments', []), 'translations': state.translations,
            'unrecognized_regions': (state.analysis or {}).get('unrecognized_regions', []),
            'artifacts': {name: value for name, value in state.artifacts.items() if available(db.get(Asset, value))},
            'timings': state.timings}


@app.post("/v1/translations/{mode}", status_code=202, response_model=JobResponse)
async def translate(mode: Literal["redraw", "classic"], target_language: Annotated[str, Form()], asset_id: Annotated[str | None, Form()] = None,
                    image: Annotated[UploadFile | None, File()] = None, idempotency_key: Annotated[str | None, Header()] = None,
                    user: User = Depends(identity), db: Session = Depends(get_db)):
    key = idem_key(idempotency_key)
    if (image is None) == (asset_id is None):
        problem("INVALID_REQUEST", "image 与 asset_id 必须且只能提供一个", 422)
    asset = owned_asset(db, asset_id, user.id) if asset_id else create_asset(db, user.id, await upload_bytes(image))
    try:
        job = create_job(db, user, asset, mode, target_language, key)
        db.commit()
    except IntegrityError:
        db.rollback()
        # A concurrent duplicate may have won the unique user/operation/key constraint.
        job = db.scalar(select(Job).where(Job.owner_id == user.id, Job.operation == f"translate:{mode}", Job.idempotency_key == key))
        if not job:
            problem("REQUEST_CONFLICT", "任务创建遇到并发冲突，请用相同操作编号重试", 409)
        from .providers import digest
        if job.request_hash != digest({"asset_hash": asset.sha256, "mode": mode, "language": target_language, "force": False}):
            problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他输入", 409)
    return job_json(db, job)


@app.post("/v1/jobs/status", response_model=JobsResponse)
def jobs_status(body: StatusRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    jobs = db.scalars(select(Job).where(Job.id.in_(body.ids), Job.owner_id == user.id)).all()
    indexed = {job.id: job for job in jobs}
    return {"items": [job_json(db, indexed[key]) for key in dict.fromkeys(body.ids) if key in indexed]}


@app.get("/v1/jobs", response_model=JobPageResponse)
def jobs_list(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(identity), db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id))
    jobs = db.scalars(select(Job).where(Job.owner_id == user.id).order_by(Job.created_at.desc()).offset(offset).limit(limit))
    return {"items": [job_json(db, job) for job in jobs], "total": total, "next_offset": offset + limit if offset + limit < total else None}


@app.get("/v1/jobs/{job_id}", response_model=JobResponse)
def job_get(job_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    return job_json(db, owned_job(db, job_id, user.id))


@app.post("/v1/jobs/{job_id}/cancel", response_model=JobResponse)
def job_cancel(job_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    job = owned_job(db, job_id, user.id, lock=True)
    cancel_job(db, job)
    db.commit()
    return job_json(db, job)


@app.post("/v1/jobs/{job_id}/rerun", status_code=202, response_model=JobResponse)
def job_rerun(job_id: str, body: RerunRequest, idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(identity), db: Session = Depends(get_db)):
    original = owned_job(db, job_id, user.id)
    if original.status == "outcome_unknown" and not body.acknowledge_unknown_cost:
        problem("UNKNOWN_COST_ACK_REQUIRED", "原请求可能已产生供应商消耗。确认后可主动创建新版本", 409)
    asset = owned_asset(db, original.input_asset_id, user.id)
    job = create_job(db, user, asset, original.mode, original.target_language, idem_key(idempotency_key), operation=f"rerun:{original.id}", force=True, quote_id=body.quote_id, max_credits=body.max_credits)
    db.commit()
    return job_json(db, job)


@app.post("/v1/quotes", status_code=201, response_model=QuoteResponse)
def quote_create(body: QuoteRequest, user: User = Depends(identity), db: Session = Depends(get_db)):
    return quote_json(create_quote(db, user, body.asset_ids, body.mode, body.target_language))


@app.post("/v1/translation-batches", status_code=202, response_model=BatchCreatedResponse)
def batch_create(body: BatchRequest, idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(identity), db: Session = Depends(get_db)):
    batch = create_batch(db, user, body.quote_id, body.max_credits, idem_key(idempotency_key))
    jobs = db.scalars(select(Job).where(Job.batch_id == batch.id).order_by(Job.ordinal)).all()
    return {"id": batch.id, "status": batch_status(jobs), "jobs": [job_json(db, job) for job in jobs], "total_cost": batch.total_cost}


def owned_batch(db, batch_id, owner_id):
    batch = db.get(Batch, batch_id)
    if not batch or batch.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此批次", 404)
    return batch


@app.get("/v1/translation-batches/{batch_id}", response_model=BatchResponse)
def batch_get(batch_id: str, offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(identity), db: Session = Depends(get_db)):
    batch = owned_batch(db, batch_id, user.id)
    jobs = db.scalars(select(Job).where(Job.batch_id == batch.id).order_by(Job.ordinal)).all()
    return {"id": batch.id, "status": batch_status(jobs), "items": [job_json(db, job) for job in jobs[offset:offset + limit]], "total": len(jobs), "next_offset": offset + limit if offset + limit < len(jobs) else None, "total_cost": batch.total_cost}


@app.post("/v1/translation-batches/{batch_id}/cancel")
def batch_cancel(batch_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    batch = owned_batch(db, batch_id, user.id)
    batch.cancel_requested = True
    jobs = db.scalars(select(Job).where(Job.batch_id == batch.id).with_for_update()).all()
    for job in jobs:
        cancel_job(db, job)
    db.commit()
    return {"id": batch.id, "status": batch_status(jobs), "cancel_requested": True}


@app.get("/v1/me/usage", response_model=UsageResponse)
def usage(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(identity), db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Ledger).where(Ledger.owner_id == user.id))
    entries = db.scalars(select(Ledger).where(Ledger.owner_id == user.id).order_by(Ledger.created_at.desc()).offset(offset).limit(limit))
    return {**quota_json(user), "items": [{"id": row.id, "job_id": row.job_id, "kind": row.kind, "amount": row.amount, "note": row.note, "created_at": row.created_at.isoformat() + "Z"} for row in entries], "total": total, "next_offset": offset + limit if offset + limit < total else None}


def provider_json(provider):
    return {**provider.config, "enabled": provider.enabled, "credential_configured": bool(credential(provider.config)), "validated_at": provider.validated_at.isoformat() + "Z" if provider.validated_at else None, "validation_job_id": provider.validation_job_id}


@app.get("/v1/admin/providers")
def provider_list(user: User = Depends(admin), db: Session = Depends(get_db)):
    return {"items": [provider_json(row) for row in db.scalars(select(Provider).order_by(Provider.id))]}


@app.put("/v1/admin/providers/{provider_id}")
def provider_put(provider_id: str, body: ProviderConfig, user: User = Depends(admin), db: Session = Depends(get_db)):
    if provider_id != body.id:
        problem("INVALID_REQUEST", "供应商编号不一致", 422)
    if set(body.parameters) - set(body.allowed_parameters) or set(body.parameters) & {"model", "prompt", "image", "image[]", "n", "stream"}:
        problem("PROVIDER_CONFIG_INVALID", "参数超出白名单", 422)
    from .adapters.images import safe_endpoint
    from .errors import ProcessingError
    try:
        safe_endpoint(body.base_url, allow_private=settings().allow_private_providers)
    except ProcessingError as error:
        problem(error.code, error.message, 422)
    provider = db.get(Provider, provider_id)
    if not provider:
        provider = Provider(id=provider_id, config=body.model_dump(), enabled=body.enabled)
        db.add(provider)
    elif provider.config != body.model_dump():
        provider.config, provider.enabled = body.model_dump(), body.enabled
        provider.validated_at, provider.validation_job_id = None, None
    db.commit()
    return provider_json(provider)


@app.patch("/v1/admin/providers/{provider_id}")
def provider_toggle(provider_id: str, body: ProviderToggle, user: User = Depends(admin), db: Session = Depends(get_db)):
    provider = db.get(Provider, provider_id)
    if not provider:
        problem("NOT_FOUND", "供应商不存在", 404)
    provider.enabled = body.enabled
    db.commit()
    return provider_json(provider)


@app.post("/v1/admin/providers/{provider_id}/test", status_code=202, response_model=JobResponse)
async def provider_test(provider_id: str, image: Annotated[UploadFile, File()], target_language: Annotated[str, Form()] = "zh-Hans", idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(admin), db: Session = Depends(get_db)):
    config = configuration(db, "redraw", target_language, provider_id)
    asset = create_asset(db, user.id, await upload_bytes(image))
    job = create_job(db, user, asset, "redraw", target_language, idem_key(idempotency_key), operation=f"provider-test:{provider_id}", force=True, config=config)
    db.commit()
    return job_json(db, job)


@app.get("/v1/admin/jobs")
def admin_jobs(status: str | None = Query(None, max_length=24), offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(admin), db: Session = Depends(get_db)):
    query = select(Job)
    if status:
        query = query.where(Job.status == status)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    jobs = db.scalars(query.order_by(Job.created_at.desc()).offset(offset).limit(limit)).all()
    items = []
    for job in jobs:
        attempt = db.get(Attempt, job.attempt_id) if job.attempt_id else None
        calls = db.scalars(select(TextCall).where(TextCall.job_id == job.id).order_by(TextCall.started_at)).all()
        items.append({**job_json(db, job), "owner_id": job.owner_id, "provider_id": attempt.provider_id if attempt else None,
                      "provider_request_id": attempt.request_id if attempt else None, "provider_usage": attempt.usage if attempt else None, "provider_cost_state": attempt.cost_state if attempt else None,
                      'text_cost_micros': sum(call.accounted_micros for call in calls),
                      'text_calls': [{'id': call.id, 'group': call.group_index, 'sequence': call.sequence, 'model': call.model,
                                      'request_id': call.request_id, 'usage': call.usage, 'cost_state': call.cost_state,
                                      'accounted_micros': call.accounted_micros, 'error_code': call.error_code} for call in calls]})
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}


@app.get("/v1/admin/users")
def admin_users(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(User).order_by(User.created_at.desc()).offset(offset).limit(limit))
    return {"items": [{**user_json(row), **quota_json(row)} for row in rows], "total": db.scalar(select(func.count()).select_from(User))}


@app.post("/v1/admin/users/{user_id}/quota")
def admin_quota(user_id: str, body: QuotaAdjustment, idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(admin), db: Session = Depends(get_db)):
    key = f"quota:{user.id}:{idem_key(idempotency_key)}"
    target = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if not target:
        problem("NOT_FOUND", "用户不存在", 404)
    existing = db.scalar(select(Ledger).where(Ledger.transaction_key == key))
    if existing:
        if existing.owner_id != user_id or existing.amount != body.amount or existing.note != body.note:
            problem("IDEMPOTENCY_CONFLICT", "额度操作编号已用于其他调整", 409)
        return {**user_json(target), **quota_json(target)}
    if target.balance + body.amount < target.reserved:
        problem("INSUFFICIENT_QUOTA", "调整后额度不能低于已预占额度", 409)
    target.balance += body.amount
    db.add(Ledger(owner_id=user_id, transaction_key=key, kind="adjustment", amount=body.amount, note=body.note))
    db.commit()
    return {**user_json(target), **quota_json(target)}


@app.post("/v1/admin/jobs/{job_id}/reconcile", response_model=JobResponse)
def reconcile(job_id: str, body: ReconcileRequest, user: User = Depends(admin), db: Session = Depends(get_db)):
    job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
    if not job:
        problem("NOT_FOUND", "任务不存在", 404)
    if job.status != "outcome_unknown":
        problem("INVALID_STATE", "仅可核实结果不明的任务", 409)
    if body.resolution == "succeeded":
        if job.discard_output or job.cancel_requested:
            problem("INVALID_STATE", "用户已取消或删除，不能重新交付", 409)
        if not body.output_asset_id:
            problem("INVALID_REQUEST", "成功核实必须提供已上传且属于原用户的结果图片", 422)
        output = owned_asset(db, body.output_asset_id, job.owner_id)
        source = owned_asset(db, job.input_asset_id, job.owner_id)
        if output.id == source.id:
            problem("INVALID_PROVIDER_OUTPUT", "核实图片必须是单独上传的结果版本", 422)
        ratio = (output.width / output.height) / (source.width / source.height)
        if not 0.8 <= ratio <= 1.25:
            problem("INVALID_PROVIDER_OUTPUT", "核实结果宽高比偏离原图", 422)
        job.output_asset_id = output.id
        output.kind, output.parent_id = job.mode, source.id
        output.expires_at = min(output.expires_at, source.expires_at)
        job.status, job.phase = "succeeded", "completed"
        settle(db, job, success=True)
    else:
        job.status, job.phase = "failed", "failed"
        settle(db, job, success=False)
    job.completed_at, job.error_code, job.error_message = now(), None, None
    db.add(Ledger(owner_id=job.owner_id, job_id=job.id, transaction_key=f"{job.id}:reconcile", kind="reconcile", amount=0, note=body.note))
    db.commit()
    return job_json(db, job)
