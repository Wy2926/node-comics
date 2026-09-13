from datetime import timedelta
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from .assets import available, owned_asset
from .config import settings
from .errors import problem
from .models import Asset, Batch, Job, Ledger, Outbox, Quote, User, now, uid
from .providers import configuration, digest, validate_input

TERMINAL = {"succeeded", "no_text", "failed", "cancelled"}


def locked_user(db: Session, owner_id: str):
    return db.scalar(select(User).where(User.id == owner_id).with_for_update().execution_options(populate_existing=True))


def idem_key(value: str | None):
    if not value or not 1 <= len(value) <= 128 or not value.isascii():
        problem("IDEMPOTENCY_KEY_REQUIRED", "请提供 1–128 个 ASCII 字符的 Idempotency-Key", 422)
    return value


def quota_json(user: User):
    return {"balance": user.balance, "reserved": user.reserved, "available": user.balance - user.reserved}


def job_json(db: Session, job: Job):
    output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
    result_available = available(output) and available(db.get(Asset, job.input_asset_id))
    return {"id": job.id, "input_asset_id": job.input_asset_id, "output_asset_id": output.id if result_available else None,
            "result_available": result_available, "result_expired": bool(job.output_asset_id and not result_available),
            "mode": job.mode, "target_language": job.target_language, "status": job.status, "phase": job.phase,
            "cost": job.cost, "settlement": job.settlement, "version": job.version, "cache_hit": job.cache_hit,
            "batch_id": job.batch_id, "ordinal": job.ordinal, "cancel_requested": job.cancel_requested,
            "error": {"code": job.error_code, "message": job.error_message} if job.error_code else None,
            "quality_flags": job.quality_flags, "created_at": job.created_at.isoformat() + "Z",
            "completed_at": job.completed_at.isoformat() + "Z" if job.completed_at else None}


def owned_job(db: Session, job_id: str, owner_id: str, *, lock=False):
    query = select(Job).where(Job.id == job_id, Job.owner_id == owner_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
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
    existing = db.scalar(select(Job).where(Job.owner_id == user.id, Job.operation == operation, Job.idempotency_key == key))
    if existing:
        if existing.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他图片或参数，请生成新的操作编号", 409)
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
    active = db.scalar(select(func.count()).select_from(Job).where(Job.owner_id == user.id, Job.status.in_(["queued", "running", "outcome_unknown"])))
    if active >= settings().max_active_jobs:
        problem("TOO_MANY_JOBS", "当前待处理任务过多，请等待任务完成", 429)
    cache_key = digest({"owner": user.id, "hash": asset.sha256, "mode": mode, "language": language, "config_version": config["version"]})
    cached = None
    if not force:
        for candidate in db.scalars(select(Job).where(Job.owner_id == user.id, Job.cache_key == cache_key, Job.status == "succeeded").order_by(Job.created_at.desc()).limit(50)):
            if available(db.get(Asset, candidate.output_asset_id)) and available(db.get(Asset, candidate.input_asset_id)):
                cached = candidate
                break
    version = (db.scalar(select(func.max(Job.version)).where(Job.owner_id == user.id, Job.cache_key == cache_key)) or 0) + 1
    job = Job(id=uid(), owner_id=user.id, input_asset_id=asset.id, mode=mode, target_language=language,
              operation=operation, idempotency_key=key, request_hash=request_hash, cache_key=cache_key,
              config=config, cost=0 if cached else config["unit_cost"], version=version, batch_id=batch_id, ordinal=ordinal)
    if cached:
        job.status, job.phase, job.cache_hit = "succeeded", "completed", True
        job.output_asset_id, job.completed_at = cached.output_asset_id, now()
    db.add(job)
    db.flush()
    reserve(db, user, job)
    if not cached:
        db.add(Outbox(job_id=job.id))
    db.flush()
    return job


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
    if user.balance - user.reserved < quote.total_cost:
        problem("INSUFFICIENT_QUOTA", "可用额度不足以启动此批次", 409)
    batch = Batch(id=uid(), owner_id=user.id, quote_id=quote.id, idempotency_key=key, request_hash=request_hash, total_cost=quote.total_cost)
    db.add(batch)
    db.flush()
    for ordinal, asset_id in enumerate(quote.asset_ids):
        asset = owned_asset(db, asset_id, user.id)
        create_job(db, user, asset, quote.mode, quote.language, f"{batch.id}:{ordinal}", operation="batch", config=config, batch_id=batch.id, ordinal=ordinal)
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
