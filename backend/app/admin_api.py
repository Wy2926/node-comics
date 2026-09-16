"""Operator-only provider, quota and reconciliation routes."""
from typing import Annotated, Literal
from datetime import timedelta
from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from pydantic import Field
from starlette.concurrency import run_in_threadpool
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .assets import create_asset, extend_original_retention, owned_asset, read_asset, retention_deadline, upload_bytes
from .storage import get_store
from .auth import admin, user_json
from .config import settings
from .db import get_db
from .errors import problem
from .jobs import create_job, idem_key, job_json, settle
from .entitlements import change_membership, compensate, entitlements_json
from .models import Asset, Attempt, Job, Ledger, Provider, TextCall, User, now
from .scheduler import lock_scheduler
from .queue_models import ComputeNode, ExecutionLease
from .providers import ProviderConfig, configuration, credential
from .request_models import RequestBody
from .schemas import JobResponse

router = APIRouter()


class MembershipRequest(RequestBody):
    action: Literal["extend", "expire"] = "extend"
    months: int = Field(default=1, ge=1, le=120, strict=True)
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


def provider_json(provider):
    return {**provider.config, "enabled": provider.enabled, "credential_configured": bool(credential(provider.config)), "validated_at": provider.validated_at.isoformat() + "Z" if provider.validated_at else None, "validation_job_id": provider.validation_job_id}


@router.get("/v1/admin/providers")
def provider_list(user: User = Depends(admin), db: Session = Depends(get_db)):
    return {"items": [provider_json(row) for row in db.scalars(select(Provider).order_by(Provider.id))]}


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
    if not provider:
        provider = Provider(id=provider_id, config=body.model_dump(), enabled=body.enabled)
        db.add(provider)
    elif provider.config != body.model_dump():
        provider.config, provider.enabled = body.model_dump(), body.enabled
        provider.validated_at, provider.validation_job_id = None, None
    db.commit()
    return provider_json(provider)


@router.patch("/v1/admin/providers/{provider_id}")
def provider_toggle(provider_id: str, body: ProviderToggle, user: User = Depends(admin), db: Session = Depends(get_db)):
    provider = db.get(Provider, provider_id)
    if not provider:
        problem("NOT_FOUND", "供应商不存在", 404)
    provider.enabled = body.enabled
    db.commit()
    return provider_json(provider)


@router.post("/v1/admin/providers/{provider_id}/test", status_code=202, response_model=JobResponse)
async def provider_test(provider_id: str, image: Annotated[UploadFile, File()], target_language: Annotated[str, Form()] = "zh-Hans", idempotency_key: Annotated[str | None, Header()] = None, user: User = Depends(admin), db: Session = Depends(get_db)):
    data = await upload_bytes(image)
    def submit():
        config = configuration(db, "redraw", target_language, provider_id)
        asset = create_asset(db, user.id, data)
        job = create_job(db, user, asset, "redraw", target_language, idem_key(idempotency_key), operation=f"provider-test:{provider_id}", force=True, config=config)
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
    job = db.scalar(select(Job).where(Job.id == job_id).with_for_update(key_share=True))
    if not job:
        problem("NOT_FOUND", "任务不存在", 404)
    if job.status not in {"outcome_unknown", "unknown_released"}:
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
        output.expires_at = retention_deadline()
        extend_original_retention(db, source, output.expires_at)
        job.status, job.phase = "succeeded", "completed"
        settle(db, job, success=True)
    else:
        job.status, job.phase = "failed", "failed"
        settle(db, job, success=False)
    job.completed_at, job.error_code, job.error_message = now(), None, None
    db.add(Ledger(owner_id=job.owner_id, job_id=job.id, transaction_key=f"{job.id}:reconcile", kind="reconcile", amount=0, note=body.note))
    db.commit()
    return job_json(db, job)


@router.post("/v1/admin/jobs/{job_id}/reconcile-image", response_model=JobResponse)
async def reconcile_image(job_id: str, image: Annotated[UploadFile, File()], note: Annotated[str, Form(min_length=1, max_length=200)],
                          user: User = Depends(admin), db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        problem("NOT_FOUND", "任务不存在", 404)
    if job.status not in {"outcome_unknown", "unknown_released"} or job.cancel_requested or job.discard_output:
        problem("INVALID_STATE", "仅可为未取消的结果不明任务补交译图", 409)
    data = await upload_bytes(image)
    def save_and_reconcile():
        # Object I/O precedes the scheduler lock. Reconciliation rechecks state;
        # a rejected late upload remains retained without granting user access.
        output = create_asset(db, job.owner_id, data, kind=job.mode, parent_id=job.input_asset_id)
        db.commit()
        return reconcile(job_id, ReconcileRequest(resolution="succeeded", output_asset_id=output.id, note=note), user, db)
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
