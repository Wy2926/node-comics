"""Authenticated compute control protocol. Nodes have no DB or supplier credentials."""
import hmac
from typing import Literal
from fastapi import APIRouter, Depends, Header
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy.orm import Session
from .assets import available, read_asset
from .config import settings
from .db import get_db
from .errors import problem, ProcessingError
from .models import Asset, ClassicState, now
from .node_admin import configuration, token_hash
from .node_config import EngineOverrides, Language
from .queue_models import ComputeNode
from .request_models import RequestBody
from .scheduler import claim_stage, current_lease, heartbeat_lease, lock_scheduler

router = APIRouter(tags=["compute"])


def node_auth(authorization: str | None = Header(default=None), x_node_id: str | None = Header(default=None),
              db: Session = Depends(get_db)):
    node = db.get(ComputeNode, x_node_id) if x_node_id else None
    token = authorization[7:] if authorization and authorization.startswith('Bearer ') else ''
    if not node or not node.credential_hash or not hmac.compare_digest(token_hash(token), node.credential_hash):
        problem("NODE_AUTH_REQUIRED", "计算节点认证失败", 401)
    return x_node_id


class NodeRegistration(RequestBody):
    capabilities: list[Literal["analyze", "inpaint", "render"]] = Field(min_length=1, max_length=3)
    engine_version: str = Field(min_length=1, max_length=120)
    device: str = Field(min_length=1, max_length=80)
    resource_id: str = Field(min_length=1, max_length=120)


@router.post("/internal/nodes/register")
def register(body: NodeRegistration, identity=Depends(node_auth), db: Session = Depends(get_db)):
    if body.engine_version == 'control':
        problem('NODE_ENGINE_INVALID', '图像节点不能声明控制资源池身份', 422)
    lock_scheduler(db)
    node = db.get(ComputeNode, identity, populate_existing=True)
    if node.resource_id != body.resource_id:
        problem('NODE_RESOURCE_MISMATCH', '设备与后台预设资源标识不一致', 409)
    for key, value in body.model_dump(exclude={'resource_id'}).items():
        setattr(node, key, value)
    node.heartbeat_at = now()
    node.applied_config_version = 0
    db.commit()
    return configuration(node)


@router.get('/internal/nodes/{node_id}/config')
def fetch_config(node_id: str, identity=Depends(node_auth), db: Session = Depends(get_db)):
    if identity != node_id:
        problem('NODE_SCOPE_MISMATCH', '节点身份不匹配', 403)
    lock_scheduler(db)
    node = db.get(ComputeNode, identity, populate_existing=True)
    node.heartbeat_at = now()
    db.commit()
    return configuration(node)


class ConfigApplied(RequestBody):
    version: int = Field(ge=1, strict=True)
    error: Literal['ENGINE_CONFIG_FAILED'] | None = None
    engine: EngineOverrides = Field(default_factory=EngineOverrides)
    supported_languages: list[Language] = Field(default_factory=list, max_length=5)


@router.post('/internal/nodes/{node_id}/config/applied')
def config_applied(node_id: str, body: ConfigApplied, identity=Depends(node_auth), db: Session = Depends(get_db)):
    if identity != node_id:
        problem('NODE_SCOPE_MISMATCH', '节点身份不匹配', 403)
    lock_scheduler(db)
    node = db.get(ComputeNode, identity, populate_existing=True)
    if body.version != node.config_version:
        problem('NODE_CONFIG_CONFLICT', '配置已更新，请重新拉取', 409)
    node.config_error = body.error
    node.heartbeat_at = now()
    if body.error:
        node.applied_config_version = 0
    else:
        effective = body.engine.model_dump(exclude_none=True)
        expected = node.desired_config['engine']
        if not body.supported_languages or any(effective.get(k) != v for k, v in expected.items()):
            problem('NODE_CONFIG_MISMATCH', '引擎未应用预期配置', 422)
        if effective.get('languages') != body.supported_languages:
            problem('NODE_CONFIG_MISMATCH', '引擎语言报告不一致', 422)
        node.applied_config_version = body.version
        node.supported_languages = body.supported_languages
        node.runtime_report = effective
    db.commit()
    return {'accepted': True}


class ClaimRequest(RequestBody):
    stages: list[Literal["analyze", "inpaint", "render"]] = Field(min_length=1, max_length=3)
    config_version: int = Field(ge=1, strict=True)


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
    node = db.get(ComputeNode, node_id)
    if body.config_version != node.config_version:
        problem('NODE_CONFIG_CONFLICT', '领取前需要同步配置', 409)
    lease = claim_stage(db, node_id, body.stages, config_version=body.config_version)
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


@router.get("/internal/leases/{lease_id}/input/authorize")
def authorize_cached_input(lease_id: str, x_lease_token: str = Header(), identity=Depends(node_auth), db: Session = Depends(get_db)):
    # Cache hits still require a current lease and a live asset. No R2 probe or
    # bytes are needed; only validated immutable content can be reused locally.
    _, _, job = node_lease(db, lease_id, x_lease_token, identity)
    source = db.get(Asset, job.input_asset_id)
    if not available(source):
        problem("ASSET_EXPIRED", "原图已失效", 410)
    return {"sha256": source.sha256}


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
