"""Content identities, idempotent jobs and settlement shared by all submissions."""
from sqlalchemy import func, select, update
from .assets import available, descriptor_available
from .translation_requests import TranslationRequest
from .errors import problem
from .models import Asset, Job, now, uid
from .entitlements import locked_user, require_entitlement, reserve, settle
from .providers import configuration, digest, validate_input
from .scheduler import ACTIVE, ensure_stages, lock_scheduler, touch_job

TERMINAL = {"succeeded", "no_text", "failed", "cancelled", "unknown_released"}


def idem_key(value):
    if not value or not 1 <= len(value) <= 128 or not value.isascii():
        problem("IDEMPOTENCY_KEY_REQUIRED", "请提供 1–128 个 ASCII 字符的 Idempotency-Key", 422)
    return value


def job_json(db, job):
    output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
    result_available = available(output)
    return {"id": job.id, "input_asset_id": job.input_asset_id,
            "output_asset_id": output.id if result_available else None, "image_sha256": job.source_sha256,
            "result_available": bool(result_available), "result_expired": bool(job.output_asset_id and not result_available),
            "mode": job.mode, "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "quota_pages": job.quota_pages, "quota_kind": job.quota_kind, "quota_period_id": job.quota_period_id,
            "settlement": job.settlement, "version": job.version,
            "cancel_requested": job.cancel_requested,
            "error": {"code": job.error_code, "message": job.error_message} if job.error_code else None,
            "quality_flags": job.quality_flags, "created_at": job.created_at.isoformat() + "Z",
            "completed_at": job.completed_at.isoformat() + "Z" if job.completed_at else None}


def owned_job(db, job_id, owner_id, *, lock=False):
    if lock:
        lock_scheduler(db)
    query = select(Job).where(Job.id == job_id, Job.owner_id == owner_id)
    if lock:
        query = query.with_for_update(key_share=True).execution_options(populate_existing=True)
    job = db.scalar(query)
    if not job:
        problem("NOT_FOUND", "找不到此任务", 404)
    return job


def request_identifier(key):
    from uuid import UUID, uuid5, NAMESPACE_URL
    try:
        return str(UUID(key))
    except ValueError:
        return str(uuid5(NAMESPACE_URL, "node-comics:internal:" + key))


def job_for_request(db, owner_id, key, request_hash):
    receipt = db.get(TranslationRequest, (owner_id, request_identifier(key)))
    if not receipt:
        return None
    if receipt.revoked_at:
        problem("TRANSLATION_UNAVAILABLE", "翻译访问已撤销", 410)
    if receipt.request_hash != request_hash:
        problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他图片或参数", 409)
    return db.get(Job, receipt.job_id)


def remember_request(db, owner_id, key, request_hash, job):
    db.add(TranslationRequest(owner_id=owner_id, id=request_identifier(key), request_hash=request_hash,
        job_id=job.id))
    db.flush()
    return job


def content_key(asset, mode, language, config):
    sha = asset.sha256 if hasattr(asset, "sha256") else asset
    return digest({"hash": sha, "mode": mode, "language": language, "config_version": config["version"], "normalization_version": 1, "result_protocol": "overlay-v1"})


def find_reusable(db, user, asset, mode, language, config):
    sha = asset.sha256 if hasattr(asset, 'sha256') else asset
    if mode == 'redraw':
        unresolved = db.scalar(select(Job).where(Job.owner_id == user.id, Job.mode == mode,
            Job.target_language == language, Job.source_sha256 == sha,
            Job.status.in_(['outcome_unknown', 'unknown_released'])).order_by(Job.created_at).limit(1))
        if unresolved:
            return unresolved
    candidates = db.scalars(select(Job).where(Job.owner_id == user.id,
        Job.cache_key == content_key(sha, mode, language, config),
        Job.status.in_(ACTIVE | {'succeeded', 'no_text'}), Job.cancel_requested.is_(False),
        Job.discard_output.is_(False)).order_by(Job.created_at.desc(), Job.id))
    for candidate in candidates:
        if user.kind == 'guest' and candidate.completed_at:
            from datetime import timedelta
            if candidate.completed_at <= now() - timedelta(hours=24):
                continue
        if candidate.input_asset_id and not descriptor_available(db.get(Asset, candidate.input_asset_id)):
            continue
        if candidate.status == 'succeeded' and candidate.output_asset_id:
            output = db.get(Asset, candidate.output_asset_id)
            if not output or output.deleted_at:
                continue
        if candidate.status in {'succeeded', 'no_text'}:
            if not db.scalar(select(TranslationRequest.id).where(TranslationRequest.owner_id == user.id,
                    TranslationRequest.job_id == candidate.id, TranslationRequest.revoked_at.is_(None)).limit(1)):
                continue
        return candidate
    return None


def create_job(db, user, asset, mode, language, key, *, operation=None, force=False, config=None,
               source_sha256=None, request_hash_override=None):
    lock_scheduler(db)
    user = locked_user(db, user.id)
    operation = operation or f"translate:{mode}"
    sha = asset.sha256 if asset else source_sha256
    if not sha or (asset and asset.kind != "original"):
        problem("INVALID_INPUT_ASSET", "翻译需要有效原图身份", 422)
    request_hash = request_hash_override or digest([sha, mode, language, force])
    existing = job_for_request(db, user.id, key, request_hash)
    if existing:
        return existing
    config = config or configuration(db, mode, language, source_sha256=sha)
    if asset:
        validate_input(asset, config)
    cached = None if force else find_reusable(db, user, sha, mode, language, config)
    if cached:
        return remember_request(db, user.id, key, request_hash, cached)
    at = now()
    ck = content_key(sha, mode, language, config)
    if not force:
        last = db.scalar(select(Job).where(Job.owner_id == user.id, Job.source_sha256 == sha,
            Job.mode == mode, Job.target_language == language, Job.cache_key == ck)
            .order_by(Job.created_at.desc(), Job.id.desc()).limit(1))
        if last and (last.status in {'failed', 'cancelled', 'unknown_released'} or
                (last.status in ACTIVE and (last.cancel_requested or last.discard_output))):
            return remember_request(db, user.id, key, request_hash, last)
    kind = require_entitlement(user, mode, at, db=db)
    version = (db.scalar(select(func.max(Job.version)).where(Job.owner_id == user.id, Job.cache_key == ck)) or 0) + 1
    job = Job(id=uid(), owner_id=user.id, input_asset_id=asset.id if asset else None, source_sha256=sha,
        mode=mode, target_language=language,
        operation=operation, idempotency_key=key, request_hash=request_hash, cache_key=ck, config=config,
        quota_pages=0, quota_kind=kind, settlement="free", version=version,
        status="queued" if asset else "awaiting_upload", phase="queued" if asset else "awaiting_upload", created_at=at)
    db.add(job)
    db.flush()
    from .translation_limits import admit_image
    admit_image(db, user, job.id)
    reserve(db, user, job, at)
    if asset:
        db.execute(update(Asset).where(Asset.id == asset.id).values(active_references=Asset.active_references + 1))
        job.input_pinned = True
        ensure_stages(db, job)
    touch_job(db, job)
    return remember_request(db, user.id, key, request_hash, job)


def cancel_job(db, job):
    if job.status in TERMINAL:
        return
    lock_scheduler(db)
    from .queue_models import ExecutionLease, JobStage
    job.cancel_requested, job.discard_output = True, True
    for stage in db.scalars(select(JobStage).where(JobStage.job_id == job.id, JobStage.status.in_(["waiting", "ready"]))):
        stage.status = "cancelled"
    running = db.scalar(select(func.count()).select_from(ExecutionLease).where(ExecutionLease.job_id == job.id, ExecutionLease.completed_at.is_(None)))
    if not running and job.status != "outcome_unknown":
        job.status, job.phase, job.completed_at = "cancelled", "cancelled", now()
        settle(db, job, success=False)
    touch_job(db, job)
