from datetime import timedelta
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from .assets import available, owned_asset
from .batch_items import BatchItem, JobRequest
from .config import settings
from .errors import problem
from .models import Asset, Batch, Job, Ledger, Outbox, Quote, User, now, uid
from .providers import configuration, digest, validate_input

TERMINAL = {"succeeded", "no_text", "failed", "cancelled"}
ACTIVE = {"queued", "running", "outcome_unknown"}


def locked_user(db: Session, owner_id: str):
    if db.get_bind().dialect.name == "sqlite":
        # SQLite has no FOR UPDATE; obtain its writer lock before reading receipts.
        db.execute(update(User).where(User.id == owner_id).values(reserved=User.reserved))
    return db.scalar(select(User).where(User.id == owner_id).with_for_update().execution_options(populate_existing=True))


def idem_key(value: str | None):
    if not value or not 1 <= len(value) <= 128 or not value.isascii():
        problem("IDEMPOTENCY_KEY_REQUIRED", "请提供 1–128 个 ASCII 字符的 Idempotency-Key", 422)
    return value


def quota_json(user: User):
    return {"balance": user.balance, "reserved": user.reserved, "available": user.balance - user.reserved}


def job_json(db: Session, job: Job, *, requested_asset_id=None, batch_id=None, ordinal=None):
    output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
    result_available = available(output) and available(db.get(Asset, job.input_asset_id))
    return {"id": job.id, "input_asset_id": job.input_asset_id, "requested_asset_id": requested_asset_id,
            "output_asset_id": output.id if result_available else None,
            "result_available": result_available, "result_expired": bool(job.output_asset_id and not result_available),
            "mode": job.mode, "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "cost": job.cost, "settlement": job.settlement, "version": job.version, "cache_hit": job.cache_hit,
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


def reserve(db: Session, user: User, job: Job):
    if job.cost == 0:
        job.settlement = "free"
        return
    updated = db.execute(update(User).where(User.id == user.id, User.balance - User.reserved >= job.cost).values(reserved=User.reserved + job.cost))
    if updated.rowcount != 1:
        problem("INSUFFICIENT_QUOTA", "可用额度不足，请缩小翻译范围或联系管理员", 409)
    db.add(Ledger(owner_id=user.id, job_id=job.id, transaction_key=f"{job.id}:reserve", kind="reserve", amount=job.cost))


def settle(db: Session, job: Job, *, success: bool):
    # Caller holds the job row lock. A released unknown attempt can deliver late without another debit.
    if job.settlement != "reserved":
        return
    operation = "settle" if success else "release"
    changes = {"reserved": User.reserved - job.cost}
    if success:
        changes["balance"] = User.balance - job.cost
    db.execute(update(User).where(User.id == job.owner_id).values(**changes))
    db.add(Ledger(owner_id=job.owner_id, job_id=job.id, transaction_key=f"{job.id}:{operation}", kind=operation, amount=job.cost))
    job.settlement = "settled" if success else "released"


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


def create_job(db: Session, user: User, asset: Asset, mode: str, language: str, key: str, *, operation=None, force=False, config=None, batch_id=None, ordinal=0, quote_id=None, max_credits=None):
    if asset.kind != "original":
        problem("INVALID_INPUT_ASSET", "请使用该页原图创建新的翻译版本", 422)
    operation = operation or f"translate:{mode}"
    request_parameters = {"asset_hash": asset.sha256, "mode": mode, "language": language, "force": force}
    if quote_id is not None:
        request_parameters.update(quote_id=quote_id, max_credits=max_credits)
    request_hash = digest(request_parameters)
    # Lock ordering: account -> new job. Existing job completion only updates the account after its own lock.
    user = locked_user(db, user.id)
    existing = job_for_request(db, user.id, operation, key, request_hash)
    if existing:
        return existing
    config = config or configuration(db, mode, language)
    if quote_id is not None:
        quote = db.get(Quote, quote_id)
        if not quote or quote.owner_id != user.id:
            problem("NOT_FOUND", "报价不存在", 404)
        if quote.asset_ids != [asset.id] or quote.mode != mode or quote.language != language:
            problem("QUOTE_MISMATCH", "报价与此页或目标语言不一致，请重新估算", 409)
        if quote.expires_at <= now():
            problem("QUOTE_EXPIRED", "报价已过期，请重新估算", 409)
        if quote.config_version != config["version"] or quote.total_cost != config["unit_cost"]:
            problem("QUOTE_CHANGED", "服务配置或额度已更新，请重新估算并确认", 409)
        if max_credits is None or max_credits < quote.total_cost:
            problem("BUDGET_EXCEEDED", "此版本预计额度超过已确认的预算", 409)
    validate_input(asset, config)
    cache_key = digest({"owner": user.id, "hash": asset.sha256, "mode": mode, "language": language, "config_version": config["version"]})
    cached = None
    if not force:
        if mode == "redraw":
            # A new provider/price does not resolve an earlier paid call. Keep
            # normal submissions bound to its unknown outcome across configs;
            # only an explicitly acknowledged force/rerun may create a new call.
            unknown = db.scalars(select(Job).join(Asset, Asset.id == Job.input_asset_id)
                                 .where(Job.owner_id == user.id, Job.mode == mode, Job.target_language == language,
                                        Asset.sha256 == asset.sha256, Job.status == "outcome_unknown",
                                        Job.cancel_requested.is_(False), Job.discard_output.is_(False))
                                 .order_by(Job.created_at, Job.id))
            for candidate in unknown:
                source = db.get(Asset, candidate.input_asset_id)
                if source.owner_id == user.id and available(source):
                    return remember_request(db, user.id, operation, key, request_hash, candidate)
        # Serialize competing devices using the account lock, without locking an
        # existing Job (completion takes Job -> User). Each new request key gets
        # its own durable receipt, including reuse of outcome_unknown jobs.
        candidates = db.scalars(select(Job).where(Job.owner_id == user.id, Job.cache_key == cache_key,
                                                 Job.status.in_(ACTIVE), Job.cancel_requested.is_(False),
                                                 Job.discard_output.is_(False)).order_by(Job.created_at, Job.id))
        for candidate in candidates:
            source = db.get(Asset, candidate.input_asset_id)
            if source and source.owner_id == user.id and available(source):
                return remember_request(db, user.id, operation, key, request_hash, candidate)
        for candidate in db.scalars(select(Job).where(Job.owner_id == user.id, Job.cache_key == cache_key,
                                                      Job.status.in_(["succeeded", "no_text"]), Job.cancel_requested.is_(False),
                                                      Job.discard_output.is_(False)).order_by(Job.created_at.desc()).limit(50)):
            if available(db.get(Asset, candidate.input_asset_id)) and (candidate.status == "no_text" or available(db.get(Asset, candidate.output_asset_id))):
                cached = candidate
                break
    if not cached:
        active = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id, Job.status.in_(ACTIVE)))
        if active >= settings().max_active_jobs:
            problem("TOO_MANY_JOBS", "当前待处理任务过多，请等待任务完成", 429)
    version = (db.scalar(select(func.max(Job.version)).where(Job.owner_id == user.id, Job.cache_key == cache_key)) or 0) + 1
    job = Job(id=uid(), owner_id=user.id, input_asset_id=asset.id, mode=mode, target_language=language,
              operation=operation, idempotency_key=key, request_hash=request_hash, cache_key=cache_key,
              config=config, cost=0 if cached else config["unit_cost"], version=version, batch_id=batch_id, ordinal=ordinal)
    if cached:
        job.status, job.phase, job.cache_hit = cached.status, "completed", True
        job.output_asset_id, job.completed_at = cached.output_asset_id if cached.status == "succeeded" else None, now()
        job.quality_flags = cached.quality_flags
    db.add(job)
    db.flush()
    reserve(db, user, job)
    if not cached:
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


def create_quote(db: Session, user: User, asset_ids: list[str], mode: str, language: str):
    if not asset_ids or len(asset_ids) > settings().max_batch or len(set(asset_ids)) != len(asset_ids):
        problem("INVALID_BATCH", f"请选择 1–{settings().max_batch} 张不重复的图片", 422)
    config = configuration(db, mode, language)
    for asset_id in asset_ids:
        validate_input(owned_asset(db, asset_id, user.id), config)
    quote = Quote(owner_id=user.id, asset_ids=asset_ids, mode=mode, language=language, config_version=config["version"], total_cost=config["unit_cost"] * len(asset_ids), unit_cost=config["unit_cost"], expires_at=now() + timedelta(minutes=5))
    db.add(quote)
    db.commit()
    return quote


def quote_json(quote):
    return {"id": quote.id, "total_cost": quote.total_cost, "unit_cost": quote.unit_cost, "page_count": len(quote.asset_ids), "expires_at": quote.expires_at.isoformat() + "Z", "config_version": quote.config_version, "mode": quote.mode, "target_language": quote.language}


def create_batch(db: Session, user: User, quote_id: str, max_credits: int, key: str):
    user = locked_user(db, user.id)
    request_hash = digest({"quote_id": quote_id, "max_credits": max_credits})
    existing = db.scalar(select(Batch).where(Batch.owner_id == user.id, Batch.idempotency_key == key))
    if existing:
        if existing.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他批次", 409)
        return existing
    quote = db.get(Quote, quote_id)
    if not quote or quote.owner_id != user.id:
        problem("NOT_FOUND", "报价不存在", 404)
    if db.scalar(select(Batch).where(Batch.quote_id == quote.id)):
        problem("QUOTE_ALREADY_USED", "此报价已创建批次，请查询原批次", 409)
    if quote.expires_at <= now():
        problem("QUOTE_EXPIRED", "报价已过期，请重新估算", 409)
    config = configuration(db, quote.mode, quote.language)
    if config["version"] != quote.config_version:
        problem("QUOTE_CHANGED", "服务配置已更新，请重新估算", 409)
    if max_credits < quote.total_cost:
        problem("BUDGET_EXCEEDED", "批次预计额度超过已确认的预算", 409)
    # Quotes bind the approved upper bound; only genuinely new work reserves
    # quota. A later failure rolls back the whole batch, receipts and reservations.
    batch = Batch(id=uid(), owner_id=user.id, quote_id=quote.id, idempotency_key=key, request_hash=request_hash, total_cost=0)
    db.add(batch)
    db.flush()
    counted = set()
    for ordinal, asset_id in enumerate(quote.asset_ids):
        asset = owned_asset(db, asset_id, user.id)
        job = create_job(db, user, asset, quote.mode, quote.language, f"{batch.id}:{ordinal}", operation="batch", config=config, batch_id=batch.id, ordinal=ordinal)
        db.add(BatchItem(batch_id=batch.id, ordinal=ordinal, input_asset_id=asset.id, job_id=job.id))
        if job.batch_id == batch.id and job.id not in counted:
            batch.total_cost += job.cost
            counted.add(job.id)
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
