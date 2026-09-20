"""Content identities, idempotent jobs and settlement shared by all submissions."""
from sqlalchemy import func, select, update
from .assets import available, find_shared_original, grant_asset
from .plan_models import TranslationOperation
from .config import settings
from .errors import problem
from .models import Asset, Job, User, now, uid
from .results import ReaderEntry, ResultAccess, get_entry, resolve_candidate, shared_candidate, valid_asset_sql
from sqlalchemy.orm import aliased
from sqlalchemy import or_
from .entitlements import UNLIMITED, locked_user, quota_kind, require_entitlement, reserve, settle
from .providers import configuration, digest, validate_input
from .scheduler import ACTIVE, ensure_stages, lock_scheduler, touch_job

TERMINAL = {"succeeded", "no_text", "failed", "cancelled", "unknown_released"}


def idem_key(value):
    if not value or not 1 <= len(value) <= 128 or not value.isascii():
        problem("IDEMPOTENCY_KEY_REQUIRED", "请提供 1–128 个 ASCII 字符的 Idempotency-Key", 422)
    return value


def job_json(db, job, *, requested_asset_id=None):
    source = db.get(Asset, job.input_asset_id) if job.input_asset_id else None
    output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
    result_available = available(output) and available(source)
    return {"id": job.id, "input_asset_id": job.input_asset_id, "requested_asset_id": requested_asset_id,
            "output_asset_id": output.id if result_available else None, "image_sha256": job.source_sha256,
            "file_hash": job.file_hash, "page_index": job.page_index, "change_sequence": job.change_sequence,
            "result_available": bool(result_available), "result_expired": bool(job.output_asset_id and not result_available),
            "mode": job.mode, "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "priority": "realtime" if job.realtime_until and job.realtime_until > now() else "preload",
            "quota_pages": job.quota_pages, "quota_kind": job.quota_kind, "quota_period_id": job.quota_period_id,
            "settlement": job.settlement, "version": job.version, "cache_hit": job.cache_hit,
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
        job = db.scalar(select(ReaderEntry).where(ReaderEntry.id == job_id, ReaderEntry.owner_id == owner_id))
    if not job:
        problem("NOT_FOUND", "找不到此任务", 404)
    return job


def job_for_request(db, owner_id, operation, key, request_hash):
    receipt = db.get(TranslationOperation, (owner_id, key))
    if not receipt:
        return None
    if receipt.request_hash != request_hash:
        problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他图片或参数", 409)
    return get_entry(db, receipt.entry_id)


def remember_request(db, owner_id, operation, key, request_hash, job):
    db.add(TranslationOperation(owner_id=owner_id, operation_key=key, request_hash=request_hash,
        job_id=job.id if isinstance(job, Job) else None, access_id=None if isinstance(job, Job) else job.id))
    db.flush()
    return job


def content_key(user, asset, mode, language, config):
    sha = asset.sha256 if hasattr(asset, "sha256") else asset
    return digest({"hash": sha, "mode": mode, "language": language, "config_version": config["version"]})


def find_shared_result(db, cache_key, hint=None):
    return resolve_candidate(db, cache_key, hint) or resolve_candidate(db, cache_key, shared_candidate(db, cache_key))


def find_reusable(db, user, asset, mode, language, config):
    sha = asset.sha256 if hasattr(asset, "sha256") else asset
    if mode == "redraw":
        unresolved = db.scalar(select(Job).where(Job.owner_id == user.id, Job.mode == mode,
            Job.target_language == language, Job.source_sha256 == sha,
            Job.status.in_(["outcome_unknown", "unknown_released"])).order_by(Job.created_at).limit(1))
        if unresolved:
            return unresolved
    entry, source, output = ReaderEntry, aliased(Asset), aliased(Asset)
    candidate = db.scalar(select(entry).outerjoin(source, source.id == entry.input_asset_id).outerjoin(
        output, output.id == entry.output_asset_id).where(
        entry.owner_id == user.id, entry.cache_key == content_key(user, sha, mode, language, config),
        entry.status.in_(ACTIVE | {'succeeded', 'no_text'}), entry.cancel_requested.is_(False), entry.discard_output.is_(False),
        or_(entry.status.in_({'awaiting_upload', 'validating_upload'}),
            valid_asset_sql(source) & or_(entry.status.in_(ACTIVE | {'no_text'}), valid_asset_sql(output))))
        .order_by(entry.created_at.desc(), entry.id).limit(1))
    if not candidate:
        return None
    if candidate.status not in {'awaiting_upload', 'validating_upload'}:
        if not available(db.get(Asset, candidate.input_asset_id)) or (candidate.status == 'succeeded'
                and not available(db.get(Asset, candidate.output_asset_id))):
            return None
    return get_entry(db, candidate.id)


def create_job(db, user, asset, mode, language, key, *, operation=None, force=False, config=None,
               max_quota_pages=None, expected_kind=None, accepted_at=None,
               source_sha256=None, file_hash=None, page_index=None, allow_new=True, request_hash_override=None, shared_hint=None):
    lock_scheduler(db)
    user = locked_user(db, user.id)
    operation = operation or f"translate:{mode}"
    sha = asset.sha256 if asset else source_sha256
    if not sha or (asset and asset.kind != "original"):
        problem("INVALID_INPUT_ASSET", "翻译需要有效原图身份", 422)
    request_hash = request_hash_override or digest([sha, mode, language, force, max_quota_pages, expected_kind])
    existing = job_for_request(db, user.id, operation, key, request_hash)
    if existing:
        return existing
    config = config or configuration(db, mode, language)
    if asset:
        validate_input(asset, config)
    cached = None if force else find_reusable(db, user, sha, mode, language, config)
    if cached:
        return remember_request(db, user.id, operation, key, request_hash, cached)
    at = accepted_at or now()
    ck = content_key(user, sha, mode, language, config)
    shared = None if force else find_shared_result(db, ck, shared_hint)
    if shared:
        result, source, translated = shared
        asset = asset or grant_asset(db, user.id, source)
        output = grant_asset(db, user.id, translated, parent_id=asset.id) if translated else None
        access = db.scalar(select(ResultAccess).where(ResultAccess.owner_id == user.id, ResultAccess.result_id == result.id))
        if access is None:
            version = (db.scalar(select(func.max(ReaderEntry.version)).where(ReaderEntry.owner_id == user.id, ReaderEntry.cache_key == ck)) or 0) + 1
            access = ResultAccess(owner_id=user.id, result_id=result.id, input_asset_id=asset.id,
                output_asset_id=output.id if output else None, version=version, created_at=at)
            db.add(access)
        else:
            # A fresh authorized request can renew a revoked grant without
            # allocating another record for the same user/generated version.
            access.input_asset_id, access.output_asset_id = asset.id, output.id if output else None
        db.flush()
        touch_job(db, access)
        entry = db.get(ReaderEntry, access.id, populate_existing=True)
        return remember_request(db, user.id, operation, key, request_hash, entry)
    if not force:
        last = db.scalar(select(Job).where(Job.owner_id == user.id, Job.source_sha256 == sha,
            Job.mode == mode, Job.target_language == language)
            .order_by(Job.created_at.desc(), Job.id.desc()).limit(1))
        if last and last.status in {'failed', 'cancelled', 'unknown_released'}:
            problem('MANUAL_RETRY_REQUIRED', '该页需手动重试', 409, job=job_json(db, last))
    if not allow_new:
        problem("NEW_TRANSLATION_NOT_REQUESTED", "当前只匹配已有翻译", 409)
    kind = require_entitlement(user, mode, at, expected_kind, db)
    if max_quota_pages is not None and kind != UNLIMITED and max_quota_pages < 1:
        problem("QUOTA_BOUND_EXCEEDED", "新增页数超过已确认额度上限", 409)
    version = (db.scalar(select(func.max(ReaderEntry.version)).where(ReaderEntry.owner_id == user.id, ReaderEntry.cache_key == ck)) or 0) + 1
    job = Job(id=uid(), owner_id=user.id, input_asset_id=asset.id if asset else None, source_sha256=sha,
        file_hash=file_hash, page_index=page_index, mode=mode, target_language=language,
        operation=operation, idempotency_key=key, request_hash=request_hash, cache_key=ck, config=config,
        quota_pages=0, quota_kind=kind, settlement="free", version=version,
        status="queued" if asset else "awaiting_upload", phase="queued" if asset else "awaiting_upload", created_at=at)
    db.add(job)
    db.flush()
    from .plan_limits import admit_image
    admit_image(db, user, job.id)
    reserve(db, user, job, at)
    if asset:
        db.execute(update(Asset).where(Asset.id == asset.id).values(active_references=Asset.active_references + 1))
        job.input_pinned = True
        ensure_stages(db, job)
    touch_job(db, job)
    return remember_request(db, user.id, operation, key, request_hash, job)


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
