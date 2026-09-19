"""Authenticate a provisioned compute identity."""
import hmac
from fastapi import Depends, Header
from sqlalchemy.orm import Session
from .db import get_db
from .errors import problem
from .node_admin import token_hash
from .queue_models import ComputeNode


def node_auth(authorization: str | None = Header(default=None), x_node_id: str | None = Header(default=None),
              db: Session = Depends(get_db)):
    node = db.get(ComputeNode, x_node_id) if x_node_id else None
    token = authorization[7:] if authorization and authorization.startswith('Bearer ') else ''
    if not node or not node.credential_hash or not hmac.compare_digest(token_hash(token), node.credential_hash):
        problem("NODE_AUTH_REQUIRED", "计算节点认证失败", 401)
    return x_node_id
