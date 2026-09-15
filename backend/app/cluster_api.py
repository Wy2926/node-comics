"""Authenticated compute control protocol. Nodes have no DB or supplier credentials."""
import hmac
from typing import Literal
from fastapi import APIRouter, Depends, Header
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from .assets import read_asset
from .config import settings
from .db import get_db
from .errors import problem, ProcessingError
from .models import Asset, ClassicState
from .queue_models import ComputeNode
from .request_models import RequestBody
from .scheduler import claim_stage, current_lease, heartbeat_lease, lock_scheduler

router = APIRouter(tags=["compute"])


def node_auth(authorization: str | None = Header(default=None), x_node_id: str | None = Header(default=None)):
    expected = settings().cluster_node_token.get_secret_value()
    if len(expected) < 32 or not authorization or not hmac.compare_digest(authorization, "Bearer " + expected):
        problem("NODE_AUTH_REQUIRED", "计算节点认证失败", 401)
    return x_node_id


class NodeRegistration(RequestBody):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=120)
    capabilities: list[Literal["analyze", "inpaint", "render"]] = Field(min_length=1, max_length=3)
    capacity: int = Field(default=1, ge=1, le=32)
    engine_version: str = Field(max_length=120)
    device: str = Field(max_length=80)
    resource_id: str | None = Field(default=None, max_length=120)


@router.post("/internal/nodes/register")
def register(body: NodeRegistration, identity=Depends(node_auth), db: Session = Depends(get_db)):
    if identity and identity != body.id:
        problem("NODE_SCOPE_MISMATCH", "节点身份不匹配", 403)
    lock_scheduler(db)
    resource_id = body.resource_id or body.id
    other = db.scalar(select(ComputeNode).where(ComputeNode.resource_id == resource_id, ComputeNode.id != body.id))
    if other:
        problem("RESOURCE_ALREADY_REGISTERED", "此物理设备已绑定其他节点", 409)
    node = db.get(ComputeNode, body.id)
    if not node:
        node = ComputeNode(id=body.id)
        db.add(node)
    from .models import now
    for key, value in body.model_dump(exclude={"id", "resource_id"}).items():
        setattr(node, key, value)
    node.resource_id, node.enabled, node.heartbeat_at = resource_id, True, now()
    db.commit()
    return {"node_id": node.id}


class ClaimRequest(RequestBody):
    stages: list[Literal["analyze", "inpaint", "render"]] = Field(min_length=1, max_length=3)


def lease_payload(db, lease):
    _, stage, job = current_lease(db, lease.id)
    source = db.get(Asset, job.input_asset_id)
    state = db.get(ClassicState, job.id)
    return {"lease_id": lease.id, "lease_token": lease.token, "job_id": job.id, "stage": stage.name,
        "input": {"url": f"/internal/leases/{lease.id}/input", "sha256": source.sha256},
        "config": {"engine": job.config["engine"], "provider": {"timeout_seconds": settings().classic_timeout_seconds}},
        "analysis": state.analysis if state else None, "translations": state.translations if state else {},
        "language": job.target_language, "cache_key": (state.artifacts or {}).get("cache_key") if state else None,
        "expires_at": lease.expires_at.isoformat() + "Z"}


@router.post("/internal/nodes/{node_id}/claim")
def claim(node_id: str, body: ClaimRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    if identity != node_id:
        problem("NODE_SCOPE_MISMATCH", "节点身份不匹配", 403)
    lease = claim_stage(db, node_id, body.stages)
    result = {"lease": lease_payload(db, lease) if lease else None}
    db.commit()
    return result


def node_lease(db, lease_id, token, identity):
    lease, stage, job = current_lease(db, lease_id, token)
    if lease.node_id != identity:
        problem("NODE_SCOPE_MISMATCH", "此任务未授权给该节点", 403)
    return lease, stage, job


class LeaseRequest(RequestBody):
    lease_token: str = Field(min_length=1, max_length=64)


@router.post("/internal/leases/{lease_id}/heartbeat")
def heartbeat(lease_id: str, body: LeaseRequest, identity=Depends(node_auth), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node_lease(db, lease_id, body.lease_token, identity)
    lease = heartbeat_lease(db, lease_id, body.lease_token)
    db.commit()
    return {"expires_at": lease.expires_at.isoformat() + "Z"}


@router.get("/internal/leases/{lease_id}/input")
def input_image(lease_id: str, x_lease_token: str = Header(), identity=Depends(node_auth), db: Session = Depends(get_db)):
    lease, stage, job = node_lease(db, lease_id, x_lease_token, identity)
    source = db.get(Asset, job.input_asset_id)
    return Response(read_asset(source), media_type=source.mime)


class StageError(RequestBody):
    code: str = Field(max_length=80)
    message: str = Field(max_length=300)


class CompletionRequest(LeaseRequest):
    result: dict | None = None
    error: StageError | None = None


@router.post("/internal/leases/{lease_id}/complete")
def complete(lease_id: str, body: CompletionRequest, identity=Depends(node_auth)):
    if (body.result is None) == (body.error is None):
        problem("INVALID_COMPLETION", "必须且只能提交结果或错误", 422)
    from .workers import complete_stage, fail_stage, finish_stopped_lease
    if body.error:
        fail_stage(lease_id, ProcessingError(body.error.code, body.error.message), token=body.lease_token, node_id=identity)
    else:
        try:
            complete_stage(lease_id, body.result, token=body.lease_token, node_id=identity)
        except ProcessingError as error:
            if error.code == "LEASE_EXPIRED":
                finish_stopped_lease(lease_id, body.lease_token, identity)
            if error.code in {"LEASE_EXPIRED", "COMPLETION_CONFLICT"}:
                raise
            fail_stage(lease_id, error, token=body.lease_token, node_id=identity)
            return {"accepted": False, "error": {"code": error.code, "message": error.message}}
    return {"accepted": True}
