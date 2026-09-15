from datetime import timedelta
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from .assets import available, owned_asset
from .batch_items import BatchItem, JobRequest
from .config import settings
from .errors import problem
from .models import Asset, Batch, Job, Outbox, TranslationPreview, User, now, uid
from .entitlements import UNLIMITED, entitlement_version, locked_user, quota_kind, require_entitlement, reserve, settle
from .providers import configuration, digest, validate_input

TERMINAL = {"succeeded", "no_text", "failed", "cancelled"}
ACTIVE = {"queued", "running", "outcome_unknown"}


def idem_key(value: str | None):
    if not value or not 1 <= len(value) <= 128 or not value.isascii():
        problem("IDEMPOTENCY_KEY_REQUIRED", "请提供 1–128 个 ASCII 字符的 Idempotency-Key", 422)
    return value


def job_json(db: Session, job: Job, *, requested_asset_id=None, batch_id=None, ordinal=None):
    output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
    result_available = available(output) and available(db.get(Asset, job.input_asset_id))
    return {"id": job.id, "input_asset_id": job.input_asset_id, "requested_asset_id": requested_asset_id,
            "output_asset_id": output.id if result_available else None,
            "result_available": result_available, "result_expired": bool(job.output_asset_id and not result_available),
            "mode": job.mode, "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "quota_pages": job.quota_pages, "quota_kind": job.quota_kind, "quota_period_id": job.quota_period_id,
            "settlement": job.settlement, "version": job.version, "cache_hit": job.cache_hit,
            "batch_id": batch_id if batch_id is not None else job.batch_id,
            "ordinal": ordinal if ordinal is not None else job.ordinal, "cancel_requested": job.cancel_requested,
            "error": {"code": job.error_code, "message": job.error_message} if job.error_code else None,
            "quality_flags": job.quality_flags, "created_at": job.created_at.isoformat() + "Z",
            "completed_at": job.completed_at.isoformat() + "Z" if job.completed_at else None}


def owned_job(db: Session, job_id: str, owner_id: str, *, lock=False):
    query = select(Job).where(Job.id == job_id, Job.owner_id == owner_id)
    if lock:
        # IDs never change. NO KEY UPDATE keeps state writes exclusive while
        # allowing FK references from User-locked request/batch transactions.
        query = query.with_for_update(key_share=True).execution_options(populate_existing=True)
    job = db.scalar(query)
    if not job:
        problem("NOT_FOUND", "找不到此任务", 404)
    return job


def job_for_request(db, owner_id, operation, key, request_hash):
    receipt = db.get(JobRequest, (owner_id, operation, key))
    if receipt is None:
        return None
    if receipt.request_hash != request_hash:
        problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他图片或参数，请生成新的操作编号", 409)
    return db.get(Job, receipt.job_id)


def remember_request(db, owner_id, operation, key, request_hash, job):
    db.add(JobRequest(owner_id=owner_id, operation=operation, idempotency_key=key,
                      request_hash=request_hash, job_id=job.id))
    db.flush()
    return job


def content_key(user, asset, mode, language, config):
    return digest({"owner": user.id, "hash": asset.sha256, "mode": mode, "language": language,
                   "config_version": config["version"]})


def find_reusable(db, user, asset, mode, language, config):
    # A provider change cannot make an unresolved upstream call safe to repeat.
    if mode == "redraw":
        unknown = db.scalars(select(Job).join(Asset, Asset.id == Job.input_asset_id).where(
            Job.owner_id == user.id, Job.mode == mode, Job.target_language == language,
            Asset.sha256 == asset.sha256, Job.status == "outcome_unknown",
            Job.cancel_requested.is_(False), Job.discard_output.is_(False)).order_by(Job.created_at, Job.id))
        for candidate in unknown:
            if available(db.get(Asset, candidate.input_asset_id)):
                return candidate
    candidates = db.scalars(select(Job).where(Job.owner_id == user.id,
        Job.cache_key == content_key(user, asset, mode, language, config),
        Job.status.in_(ACTIVE | {"succeeded", "no_text"}), Job.cancel_requested.is_(False),
        Job.discard_output.is_(False)).order_by(Job.created_at.desc(), Job.id))
    for candidate in candidates:
        if available(db.get(Asset, candidate.input_asset_id)) and (
                candidate.status in ACTIVE or candidate.status == "no_text"
                or available(db.get(Asset, candidate.output_asset_id))):
            return candidate
    return None


def validate_preview(db, user, preview_id, at):
    preview = db.get(TranslationPreview, preview_id)
    if preview is None or preview.owner_id != user.id:
        problem("NOT_FOUND", "翻译预览不存在", 404)
    if preview.expires_at <= at:
        problem("PREVIEW_EXPIRED", "翻译预览已过期，请重新准备", 409)
    config = configuration(db, preview.mode, preview.language)
    kind = quota_kind(user, preview.mode, at, db)
    if kind != preview.quota_kind or entitlement_version(user, kind) != preview.entitlement_version:
        problem("ENTITLEMENT_CHANGED", "账户权益已变化，请重新确认翻译范围", 409)
    if config["version"] != preview.config_version:
        problem("PREVIEW_CHANGED", "翻译配置已更新，请重新准备", 409)
    return preview, config


def create_job(db: Session, user: User, asset: Asset, mode: str, language: str, key: str, *,
               operation=None, force=False, config=None, batch_id=None, ordinal=0,
               preview_id=None, max_quota_pages=None, expected_kind=None, accepted_at=None):
    if asset.kind != "original":
        problem("INVALID_INPUT_ASSET", "请使用该页原图创建新的翻译版本", 422)
    operation = operation or f"translate:{mode}"
    parameters = {"asset_hash": asset.sha256, "mode": mode, "language": language, "force": force}
    if preview_id is not None:
        parameters.update(preview_id=preview_id, max_quota_pages=max_quota_pages)
    if expected_kind is not None:
        parameters["expected_kind"] = expected_kind
    request_hash = digest(parameters)
    user = locked_user(db, user.id)
    existing = job_for_request(db, user.id, operation, key, request_hash)
    if existing:
        return existing
    at = accepted_at or now()
    config = config or configuration(db, mode, language)
    preview = None
    if preview_id is not None:
        preview, config = validate_preview(db, user, preview_id, at)
        if preview.asset_ids != [asset.id] or preview.mode != mode or preview.language != language or preview.regenerate != force:
            problem("PREVIEW_MISMATCH", "翻译预览与此页或操作不一致，请重新准备", 409)
    validate_input(asset, config)
    cached = None if force else find_reusable(db, user, asset, mode, language, config)
    if cached and cached.status in ACTIVE:
        return remember_request(db, user.id, operation, key, request_hash, cached)
    kind = quota_kind(user, mode, at, db)
    pages = 0 if cached or kind == UNLIMITED else 1
    if not cached:
        require_entitlement(user, mode, at, expected_kind, db)
        if preview is not None and (max_quota_pages is None or pages > min(preview.quota_pages, max_quota_pages)):
            problem("QUOTA_BOUND_EXCEEDED", "新增翻译页数超过已确认上限，请重新准备", 409)
        active = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id, Job.status.in_(ACTIVE)))
        if active >= settings().max_active_jobs:
            problem("TOO_MANY_JOBS", "当前待处理任务过多，请等待任务完成", 429)
    cache_key = content_key(user, asset, mode, language, config)
    version = (db.scalar(select(func.max(Job.version)).where(Job.owner_id == user.id, Job.cache_key == cache_key)) or 0) + 1
    job = Job(id=uid(), owner_id=user.id, input_asset_id=asset.id, mode=mode, target_language=language,
              operation=operation, idempotency_key=key, request_hash=request_hash, cache_key=cache_key,
              config=config, quota_pages=0, quota_kind=kind, settlement="free", version=version,
              batch_id=batch_id, ordinal=ordinal, created_at=at)
    if cached:
        job.status, job.phase, job.cache_hit = cached.status, "completed", True
        job.output_asset_id, job.completed_at = cached.output_asset_id if cached.status == "succeeded" else None, at
        job.quality_flags = cached.quality_flags
    db.add(job)
    db.flush()
    if not cached:
        reserve(db, user, job, at)
        db.add(Outbox(job_id=job.id))
    db.flush()
    return remember_request(db, user.id, operation, key, request_hash, job)


def cancel_job(db: Session, job: Job):
    if job.status in TERMINAL:
        return
    job.cancel_requested = True
    job.discard_output = True
    if job.status == "queued":
        job.status, job.phase, job.completed_at = "cancelled", "cancelled", now()
        settle(db, job, success=False)
    # Running requests remain observable until a known result or the reconciliation deadline.


def create_preview(db: Session, user: User, asset_ids: list[str], mode: str, language: str, *, regenerate=False):
    if not asset_ids or len(asset_ids) > settings().max_batch or len(set(asset_ids)) != len(asset_ids):
        problem("INVALID_BATCH", f"请选择 1–{settings().max_batch} 张不重复的图片", 422)
    if regenerate and len(asset_ids) != 1:
        problem("INVALID_BATCH", "重新翻译每次只能选择一页", 422)
    user = locked_user(db, user.id)
    at = now()
    config = configuration(db, mode, language)
    new_hashes = set()
    for asset_id in asset_ids:
        asset = owned_asset(db, asset_id, user.id)
        if asset.kind != "original":
            problem("INVALID_INPUT_ASSET", "翻译需要原图", 422)
        validate_input(asset, config)
        if regenerate or not find_reusable(db, user, asset, mode, language, config):
            new_hashes.add(asset.sha256)
    kind = quota_kind(user, mode, at, db)
    if new_hashes:
        require_entitlement(user, mode, at, db=db)
    preview = TranslationPreview(owner_id=user.id, asset_ids=asset_ids, mode=mode, language=language,
        config_version=config["version"], quota_pages=0 if kind == UNLIMITED else len(new_hashes),
        new_pages=len(new_hashes), quota_kind=kind, entitlement_version=entitlement_version(user, kind),
        regenerate=regenerate, expires_at=at + timedelta(minutes=5))
    db.add(preview)
    db.commit()
    return preview


def preview_json(preview):
    return {"id": preview.id, "quota_pages": preview.quota_pages, "quota_kind": preview.quota_kind,
            "new_pages": preview.new_pages, "reused_pages": len(preview.asset_ids) - preview.new_pages,
            "page_count": len(preview.asset_ids), "expires_at": preview.expires_at.isoformat() + "Z",
            "config_version": preview.config_version, "entitlement_version": preview.entitlement_version,
            "mode": preview.mode, "target_language": preview.language, "regenerate": preview.regenerate}


def create_batch(db: Session, user: User, preview_id: str, max_quota_pages: int, key: str):
    user = locked_user(db, user.id)
    at = now()
    request_hash = digest({"preview_id": preview_id, "max_quota_pages": max_quota_pages})
    existing = db.scalar(select(Batch).where(Batch.owner_id == user.id, Batch.idempotency_key == key))
    if existing:
        if existing.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他批次", 409)
        return existing
    preview, config = validate_preview(db, user, preview_id, at)
    if preview.regenerate:
        problem("PREVIEW_MISMATCH", "重译预览只能用于原任务的重新翻译", 409)
    if db.scalar(select(Batch).where(Batch.preview_id == preview.id)):
        problem("PREVIEW_ALREADY_USED", "此预览已创建批次，请查询原批次", 409)
    batch = Batch(id=uid(), owner_id=user.id, preview_id=preview.id, idempotency_key=key,
                  request_hash=request_hash, quota_pages=0)
    db.add(batch)
    db.flush()
    counted = set()
    for ordinal, asset_id in enumerate(preview.asset_ids):
        asset = owned_asset(db, asset_id, user.id)
        job = create_job(db, user, asset, preview.mode, preview.language, f"{batch.id}:{ordinal}",
                         operation="batch", config=config, batch_id=batch.id, ordinal=ordinal, accepted_at=at)
        db.add(BatchItem(batch_id=batch.id, ordinal=ordinal, input_asset_id=asset.id, job_id=job.id))
        if job.batch_id == batch.id and job.id not in counted:
            batch.quota_pages += job.quota_pages
            counted.add(job.id)
        if batch.quota_pages > min(preview.quota_pages, max_quota_pages):
            problem("QUOTA_BOUND_EXCEEDED", "新增翻译页数超过已确认上限，请重新准备", 409)
    db.commit()
    return batch


def batch_status(jobs):
    statuses = {job.status for job in jobs}
    if not statuses:
        return "queued"
    if "running" in statuses or "queued" in statuses:
        return "running" if statuses != {"queued"} else "queued"
    if statuses <= {"succeeded", "no_text"}:
        return "succeeded"
    if len(statuses) == 1:
        return next(iter(statuses))
    return "partial"
