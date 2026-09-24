"""Operator-only provider, quota and reconciliation routes."""
from typing import Annotated, Literal
from datetime import timedelta
from hashlib import sha256
from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from pydantic import Field, field_validator
from starlette.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .assets import content_storage_key, create_asset, extend_original_retention, inspect_image, owned_asset, read_asset, retention_deadline, upload_bytes
from .storage import get_store
from .auth import admin, user_json
from .config import settings
from .db import get_db
from .errors import problem
from .jobs import create_job, idem_key, job_for_request, job_json, settle
from .entitlements import change_membership, compensate, entitlements_json
from .models import Asset, Attempt, Job, Ledger, Provider, TextCall, User, now
from .scheduler import lock_scheduler
from .queue_models import ComputeNode, ExecutionLease
from .providers import ProviderConfig, configuration, credential, digest
from .admin_audit import record_audit
from .request_models import RequestBody
from .schemas import JobResponse

router = APIRouter()


class MembershipRequest(RequestBody):
    action: Literal["extend", "expire"] = "extend"
    months: int | None = Field(default=None, ge=1, le=120, strict=True)
    days: int | None = Field(default=None, ge=1, le=3660, strict=True)
    monthly_pages: int | None = Field(default=None, ge=0, le=1_000_000, strict=True)
    note: str = Field(min_length=1, max_length=200)


class CompensationRequest(RequestBody):
    kind: Literal["classic_daily", "redraw_monthly"]
    pages: int = Field(ge=1, le=1_000_000, strict=True)
    note: str = Field(min_length=1, max_length=200)


class ProviderToggle(RequestBody):
    enabled: bool


class ReconcileRequest(RequestBody):
    resolution: Literal["failed", "succeeded"]
    output_asset_id: str | None = None
    note: str = Field(min_length=1, max_length=200)

    @field_validator("note")
    @classmethod
    def meaningful_note(cls, value):
        if not value.strip():
            raise ValueError("核实备注不能为空")
        return value.strip()


def provider_json(provider):
    return {**provider.config, "enabled": provider.enabled, "credential_configured": bool(credential(provider.config)), "validated_at": provider.validated_at.isoformat() + "Z" if provider.validated_at else None, "validation_job_id": provider.validation_job_id}


def provider_audit_snapshot(provider):
    # Parameters are extensible supplier payloads; never copy their arbitrary
    # values into the permanent operator audit.
    value = provider_json(provider)
    snapshot = {key: value.get(key) for key in ("id", "label", "protocol", "base_url", "model", "enabled",
        "credential_ref", "credential_configured", "validated_at", "validation_job_id", "concurrency", "timeout_seconds",
        "image_field", "max_bytes", "max_pixels", "max_dimension", "input_formats", "download_hosts")}
    snapshot["configuration_version"] = digest(provider.config)
    return snapshot


@router.get("/v1/admin/providers")
def provider_list(user: User = Depends(admin), db: Session = Depends(get_db)):
    items = []
    for row in db.scalars(select(Provider).order_by(Provider.id)):
        latest = db.scalar(select(Job).where(Job.operation == f"provider-test:{row.id}")
                           .order_by(Job.created_at.desc(), Job.id.desc()).limit(1))
        items.append({**provider_json(row), "latest_test": {"id": latest.id, "status": latest.status,
            "created_at": latest.created_at.isoformat() + "Z"} if latest else None})
    return {"items": items}


@router.put("/v1/admin/providers/{provider_id}")
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
    before = provider_audit_snapshot(provider) if provider else None
    # The enabled column is authoritative; toggle operations must not leave the
    # JSON snapshot inconsistent or invalidate a working model configuration.
    incoming = body.model_dump()
    if not provider:
        provider = Provider(id=provider_id, config=incoming, enabled=body.enabled)
        db.add(provider)
    else:
        if {k: v for k, v in provider.config.items() if k != 'enabled'} != {k: v for k, v in incoming.items() if k != 'enabled'}:
            provider.validated_at, provider.validation_job_id = None, None
        provider.config, provider.enabled = incoming, body.enabled
    db.flush()
    record_audit(db, user.id, "image_provider.save", "image_provider", provider_id,
                 before=before, after=provider_audit_snapshot(provider))
    db.commit()
    return provider_json(provider)


@router.patch("/v1/admin/providers/{provider_id}")
def provider_toggle(provider_id: str, body: ProviderToggle, user: User = Depends(admin), db: Session = Depends(get_db)):
    provider = db.get(Provider, provider_id)
    if not provider:
        problem("NOT_FOUND", "供应商不存在", 404)
    before = provider_audit_snapshot(provider)
    provider.enabled = body.enabled
    provider.config = {**provider.config, "enabled": body.enabled}
    record_audit(db, user.id, "image_provider.toggle", "image_provider", provider_id,
                 before=before, after=provider_audit_snapshot(provider))
    db.commit()
    return provider_json(provider)


@router.post("/v1/admin/providers/{provider_id}/test", status_code=202, response_model=JobResponse)
async def provider_test(provider_id: str, image: Annotated[UploadFile, File()], target_language: Annotated[str, Form()] = "zh-Hans", idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(admin), db: Session = Depends(get_db)):
    data = await upload_bytes(image)
    def submit():
        key = idem_key(idempotency_key)
        request_hash = digest(["provider-test", provider_id, sha256(data).hexdigest(), target_language])
        previous = job_for_request(db, user.id, f"provider-test:{provider_id}", key, request_hash)
        if previous:
            return job_json(db, previous)
        unresolved = db.scalar(select(Job).where(Job.owner_id == user.id, Job.operation == f"provider-test:{provider_id}",
            Job.source_sha256 == sha256(data).hexdigest(), Job.target_language == target_language,
            Job.status.in_({"outcome_unknown", "unknown_released"})).limit(1))
        if unresolved:
            problem("PROVIDER_TEST_OUTCOME_UNKNOWN", "同一图片的测试结果仍待核实，请先处理原测试任务", 409, job_id=unresolved.id)
        config = configuration(db, "redraw", target_language, provider_id)
        # Verify and write immutable bytes before the global scheduler lock.
        # Concurrent submissions can safely PUT the same content key; only the
        # winner of the locked receipt check may create its access metadata.
        info = inspect_image(data)
        backend = settings().result_storage_backend
        get_store(backend).put(content_storage_key(info['sha256']), data, info['mime'], kind='original')
        lock_scheduler(db)
        from .translation_requests import TranslationRequest
        from .results import get_entry
        from .jobs import request_identifier
        receipt = db.get(TranslationRequest, (user.id, request_identifier(key)), populate_existing=True)
        if receipt:
            if receipt.request_hash != request_hash:
                problem("IDEMPOTENCY_CONFLICT", "此操作编号已用于其他图片或参数", 409)
            return job_json(db, get_entry(db, receipt.entry_id))
        unresolved = db.scalar(select(Job.id).where(Job.owner_id == user.id, Job.operation == f"provider-test:{provider_id}",
            Job.source_sha256 == info['sha256'], Job.target_language == target_language,
            Job.status.in_({"outcome_unknown", "unknown_released"})).limit(1))
        if unresolved:
            problem("PROVIDER_TEST_OUTCOME_UNKNOWN", "同一图片的测试结果仍待核实，请先处理原测试任务", 409, job_id=unresolved)
        asset = create_asset(db, user.id, data, storage_backend=backend, prewritten=True, verified_info=info)
        job = create_job(db, user, asset, "redraw", target_language, key, operation=f"provider-test:{provider_id}",
                         force=True, config=config, request_hash_override=request_hash)
        record_audit(db, user.id, "image_provider.test", "image_provider", provider_id,
                     details={"job_id": job.id, "target_language": target_language}, operation_key=key)
        db.commit()
        return job_json(db, job)
    return await run_in_threadpool(submit)


@router.get("/v1/admin/jobs")
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
                      'text_calls': [{'id': call.id, 'group': call.group_index, 'sequence': call.sequence, 'model': call.model, 'provider_id': call.provider_id,
                                      'request_id': call.request_id, 'usage': call.usage, 'cost_state': call.cost_state,
                                      'accounted_micros': call.accounted_micros, 'error_code': call.error_code} for call in calls]})
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/admin/jobs/{job_id}/attempts")
def admin_job_attempts(job_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                       user: User = Depends(admin), db: Session = Depends(get_db)):
    if not db.get(Job, job_id):
        problem("NOT_FOUND", "任务不存在", 404)
    query = select(Attempt).where(Attempt.job_id == job_id)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(Attempt.started_at.desc(), Attempt.id).offset(offset).limit(limit))
    def stamp(value):
        return value.isoformat() + "Z" if value else None
    return {"items": [{"id": row.id, "provider_id": row.provider_id, "request_id": row.request_id,
        "started_at": stamp(row.started_at), "call_started_at": stamp(row.call_started_at),
        "completed_at": stamp(row.completed_at), "heartbeat_at": stamp(row.heartbeat_at),
        "lease_expires_at": stamp(row.lease_expires_at), "cost_state": row.cost_state,
        "usage": row.usage, "error_code": row.error_code, "recovered": row.recovered} for row in rows],
        "total": total, "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/admin/users")
def admin_users(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100), user: User = Depends(admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(User).order_by(User.created_at.desc()).offset(offset).limit(limit))
    return {"items": [{**user_json(row), "entitlements": entitlements_json(db, row)} for row in rows], "total": db.scalar(select(func.count()).select_from(User))}


@router.post("/v1/admin/users/{user_id}/membership")
def admin_membership(user_id: str, body: MembershipRequest, idempotency_key: Annotated[str | None, Header()] = None,
                     user: User = Depends(admin), db: Session = Depends(get_db)):
    return change_membership(db, user_id, user.id, idem_key(idempotency_key), **body.model_dump())


@router.post("/v1/admin/users/{user_id}/quota-compensations")
def admin_compensation(user_id: str, body: CompensationRequest, idempotency_key: Annotated[str | None, Header()] = None,
                       user: User = Depends(admin), db: Session = Depends(get_db)):
    return compensate(db, user_id, user.id, idem_key(idempotency_key), **body.model_dump())


@router.post("/v1/admin/jobs/{job_id}/reconcile", response_model=JobResponse)
def reconcile(job_id: str, body: ReconcileRequest, user: User = Depends(admin), db: Session = Depends(get_db)):
    lock_scheduler(db)
    job = db.scalar(select(Job).where(Job.id == job_id).with_for_update().execution_options(populate_existing=True))
    if not job:
        problem("NOT_FOUND", "任务不存在", 404)
    previous = db.scalar(select(Ledger).where(Ledger.transaction_key == f"{job.id}:reconcile"))
    if previous:
        # A lost HTTP response can be replayed safely. A different conclusion,
        # attachment or note must never replace an already settled decision.
        same_output = body.resolution == "failed" and not body.output_asset_id
        if body.resolution == "succeeded" and body.output_asset_id:
            output = owned_asset(db, body.output_asset_id, job.owner_id)
            current = owned_asset(db, job.output_asset_id, job.owner_id) if job.output_asset_id else None
            same_output = bool(current and output.sha256 == current.sha256)
        if job.status == body.resolution and previous.note == body.note and same_output:
            return job_json(db, job)
        problem("RECONCILIATION_CONFLICT", "此任务已经核实，不能更改结论、译图或备注", 409)
    if job.status not in {"outcome_unknown", "unknown_released"}:
        problem("INVALID_STATE", "仅可核实结果不明的任务", 409)
    before = {"status": job.status, "settlement": job.settlement, "output_asset_id": job.output_asset_id}
    if body.resolution == "succeeded":
        if job.discard_output or job.cancel_requested:
            problem("INVALID_STATE", "用户已取消或删除，不能重新交付", 409)
        if not body.output_asset_id:
            problem("INVALID_REQUEST", "成功核实必须提供已上传且属于原用户的结果图片", 422)
        output = owned_asset(db, body.output_asset_id, job.owner_id)
        source = owned_asset(db, job.input_asset_id, job.owner_id)
        if output.id == source.id:
            problem("INVALID_PROVIDER_OUTPUT", "核实图片必须是单独上传的结果版本", 422)
        from .file_pages import FilePage
        from .results import ResultAccess
        if output.kind not in {"original", job.mode} or output.parent_id not in {None, source.id} or db.scalar(
            select(Job.id).where(Job.id != job.id, (Job.input_asset_id == output.id) | (Job.output_asset_id == output.id)).limit(1)) or db.scalar(
            select(FilePage.asset_id).where(FilePage.asset_id == output.id).limit(1)) or db.scalar(
            select(ResultAccess.id).where((ResultAccess.input_asset_id == output.id) | (ResultAccess.output_asset_id == output.id)).limit(1)):
            problem("INVALID_PROVIDER_OUTPUT", "该图片已关联其他任务，请单独补交本任务的译图", 422)
        ratio = (output.width / output.height) / (source.width / source.height)
        if not 0.8 <= ratio <= 1.25:
            problem("INVALID_PROVIDER_OUTPUT", "核实结果宽高比偏离原图", 422)
        job.output_asset_id = output.id
        output.kind, output.parent_id = job.mode, source.id
        output.expires_at = retention_deadline()
        extend_original_retention(db, source, output.expires_at)
        job.status, job.phase = "succeeded", "completed"
        settle(db, job, success=True)
    else:
        if body.output_asset_id:
            problem("INVALID_REQUEST", "确认失败不能附带结果图片", 422)
        job.status, job.phase = "failed", "failed"
        settle(db, job, success=False)
    job.completed_at, job.error_code, job.error_message = now(), None, None
    from .results import publish_result
    publish_result(db, job)
    db.add(Ledger(owner_id=job.owner_id, job_id=job.id, transaction_key=f"{job.id}:reconcile", kind="reconcile", amount=0, note=body.note))
    record_audit(db, user.id, "job.reconcile", "job", job.id, before=before,
                 after={"status": job.status, "settlement": job.settlement, "output_asset_id": job.output_asset_id},
                 details={"owner_id": job.owner_id}, note=body.note)
    db.commit()
    return job_json(db, job)


@router.post("/v1/admin/jobs/{job_id}/reconcile-image", response_model=JobResponse)
async def reconcile_image(job_id: str, image: Annotated[UploadFile, File()], note: Annotated[str, Form(min_length=1, max_length=200)],
                          user: User = Depends(admin), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        problem("NOT_FOUND", "任务不存在", 404)
    if job.status not in {"outcome_unknown", "unknown_released", "succeeded"} or job.cancel_requested or job.discard_output:
        problem("INVALID_STATE", "仅可为未取消的结果不明任务补交译图", 409)
    normalized = note.strip()
    if not normalized:
        problem("INVALID_REQUEST", "核实备注不能为空", 422)
    data = await upload_bytes(image)
    def save_and_reconcile():
        if job.status == "succeeded":
            output = db.get(Asset, job.output_asset_id)
            if not output or output.sha256 != sha256(data).hexdigest():
                problem("RECONCILIATION_CONFLICT", "此任务已交付其他译图，不能覆盖", 409)
            return reconcile(job_id, ReconcileRequest(resolution="succeeded", output_asset_id=output.id, note=normalized), user, db)
        # Object I/O precedes the scheduler lock. Reconciliation rechecks state;
        # a rejected late upload remains retained without granting user access.
        output = create_asset(db, job.owner_id, data, kind=job.mode, parent_id=job.input_asset_id)
        db.commit()
        return reconcile(job_id, ReconcileRequest(resolution="succeeded", output_asset_id=output.id, note=normalized), user, db)
    return await run_in_threadpool(save_and_reconcile)


@router.get("/v1/admin/compute-nodes")
def compute_nodes(user: User = Depends(admin), db: Session = Depends(get_db)):
    busy = dict(db.execute(select(ExecutionLease.node_id, func.count()).where(ExecutionLease.completed_at.is_(None)).group_by(ExecutionLease.node_id)).all())
    at = now()
    return {"items": [{"id": n.id, "name": n.name, "resource_id": n.resource_id, "device": n.device,
        "capabilities": n.capabilities, "engine_version": n.engine_version, "capacity": n.capacity,
        "config_version": n.config_version, "applied_config_version": n.applied_config_version,
        "config_error": n.config_error, "supported_languages": n.supported_languages,
        "running": busy.get(n.id, 0), "enabled": n.enabled,
        "online": bool(n.heartbeat_at and n.heartbeat_at > at - timedelta(seconds=settings().cluster_node_timeout_seconds)),
        "heartbeat_at": n.heartbeat_at.isoformat() + "Z" if n.heartbeat_at else None} for n in db.scalars(select(ComputeNode).order_by(ComputeNode.id))]}
