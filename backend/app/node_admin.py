"""Provisioned node identities. A node can never provision or enable itself."""
import hashlib
import secrets

from fastapi import APIRouter, Depends
from pydantic import Field, ValidationError
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from .auth import admin
from .config import settings
from .db import get_db
from .errors import problem
from .models import User
from .node_config import NodeConfig, EngineOverrides
from .control_pools import POOL_LIMITS
from .languages import LANGUAGES
from .queue_models import ComputeNode
from .request_models import RequestBody
from .scheduler import lock_scheduler

router = APIRouter(prefix='/v1/admin/compute-nodes', tags=['node administration'])


class NodeCreate(RequestBody):
    name: str = Field(min_length=1, max_length=120)
    resource_id: str = Field(min_length=1, max_length=120, pattern=r'^[A-Za-z0-9_.:-]+$')
    config: NodeConfig = Field(default_factory=NodeConfig)


class NodeUpdate(RequestBody):
    expected_version: int = Field(ge=1, strict=True)
    name: str = Field(min_length=1, max_length=120)
    enabled: bool
    config: dict


class PoolConfig(RequestBody):
    execution_slots: int = Field(ge=1, le=100, strict=True)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def configuration(node):
    return {'node_id': node.id, 'name': node.name, 'enabled': node.enabled,
            'resource_id': node.resource_id, 'version': node.config_version, 'config': node.desired_config}


def validate_config(config):
    if config.heartbeat_seconds * 3 > settings().cluster_lease_seconds:
        problem('NODE_CONFIG_INVALID', '心跳间隔不能超过租约时长的三分之一', 422)
    if config.config_poll_seconds >= settings().cluster_node_timeout_seconds:
        problem('NODE_CONFIG_INVALID', '配置拉取间隔必须小于节点离线时限', 422)


def compute_node(db, node_id, *, image_only=False):
    node = db.get(ComputeNode, node_id)
    if not node or (image_only and node.engine_version == 'control'):
        problem('NODE_NOT_FOUND', '计算节点不存在', 404)
    return node


@router.get('/config-schema')
def config_schema(user: User = Depends(admin)):
    return {'node': NodeConfig.model_json_schema(), 'engine': EngineOverrides.model_json_schema(),
            'defaults': NodeConfig().model_dump(exclude_none=True), 'pool_limits': POOL_LIMITS,
            'languages': [{'id': code, 'label': label} for code, label in LANGUAGES.items()]}


@router.post('', status_code=201)
def create(body: NodeCreate, user: User = Depends(admin), db: Session = Depends(get_db)):
    validate_config(body.config)
    lock_scheduler(db)
    if db.scalar(select(ComputeNode.id).where(ComputeNode.resource_id == body.resource_id)):
        problem('RESOURCE_ALREADY_REGISTERED', '此物理设备已绑定其他节点', 409)
    token = secrets.token_urlsafe(48)
    node = ComputeNode(id='node-' + secrets.token_hex(12), name=body.name, resource_id=body.resource_id,
        capabilities=[], capacity=body.config.execution_slots, engine_version='', device='',
        heartbeat_at=None, credential_hash=token_hash(token),
        desired_config=body.config.model_dump(exclude_none=True))
    db.add(node)
    db.commit()
    return {**configuration(node), 'token': token}


@router.get('/{node_id}/config')
def get_config(node_id: str, user: User = Depends(admin), db: Session = Depends(get_db)):
    node = compute_node(db, node_id)
    return {**configuration(node), 'applied_version': node.applied_config_version,
            'config_error': node.config_error, 'runtime': node.runtime_report}


@router.put('/{node_id}/config')
def update(node_id: str, body: NodeUpdate, user: User = Depends(admin), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = compute_node(db, node_id)
    if node.config_version != body.expected_version:
        problem('NODE_CONFIG_CONFLICT', '配置已更新，请刷新后重新保存', 409)
    pool = node.engine_version == 'control'
    try:
        config = (PoolConfig if pool else NodeConfig).model_validate(body.config)
    except ValidationError as error:
        raise RequestValidationError([{**item, 'loc': ('body', 'config', *item['loc'])}
                                      for item in error.errors()]) from None
    if pool:
        maximum = POOL_LIMITS[node.capabilities[0]]
        if config.execution_slots > maximum:
            problem('NODE_CONFIG_INVALID', f'此资源池执行位须为 1–{maximum} 的整数', 422)
    else:
        validate_config(config)
    node.name, node.enabled = body.name, body.enabled
    node.desired_config = config.model_dump(exclude_none=True)
    node.capacity = config.execution_slots
    node.config_version += 1
    node.config_error = None
    if pool or node.runtime_report.get('protocol_version') == 2:
        node.applied_config_version = node.config_version
    db.commit()
    return configuration(node)


@router.post('/{node_id}/rotate-credential')
def rotate(node_id: str, user: User = Depends(admin), db: Session = Depends(get_db)):
    lock_scheduler(db)
    node = compute_node(db, node_id, image_only=True)
    token = secrets.token_urlsafe(48)
    node.credential_hash = token_hash(token)
    node.applied_config_version = 0
    db.commit()
    return {'node_id': node.id, 'token': token}
