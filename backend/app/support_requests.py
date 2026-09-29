"""Anonymous plugin feedback and adapter requests. URLs are never fetched."""
from datetime import datetime
from hashlib import sha256
from ipaddress import ip_address
from typing import Annotated, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import Index, String, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from .auth import admin
from .db import Base, get_db
from .errors import problem
from .models import User, now, uid
from .providers import digest
from .request_models import RequestBody
from . import redis_state

router = APIRouter(tags=['Support requests'])


class SupportRequest(Base):
    __tablename__ = 'support_requests'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    kind: Mapped[str] = mapped_column(String(16))
    site_name: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(2048))
    comment: Mapped[str] = mapped_column(String(1000))
    contact: Mapped[str] = mapped_column(String(200))
    idempotency_key: Mapped[str] = mapped_column(String(36), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(default=now)
    __table_args__ = (Index('ix_support_requests_kind_created', 'kind', 'created_at', 'id'),)


class SupportRequestBody(RequestBody):
    kind: Literal['website', 'plugin', 'uninstall']
    site_name: str = Field(default='', max_length=100)
    url: str = Field(default='', max_length=2048)
    comment: str = Field(default='', max_length=1000)
    contact: str = Field(default='', max_length=200)

    @field_validator('site_name', 'comment', 'contact')
    @classmethod
    def trim_text(cls, value):
        value = value.strip()
        return value

    @field_validator('url')
    @classmethod
    def public_url(cls, value):
        value = value.strip()
        if not value:
            return ''
        if any(ord(char) < 33 for char in value) or '\\' in value:
            raise ValueError('请填写有效的公开网站地址')
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if parsed.scheme not in ('http', 'https') or not host or parsed.username or parsed.password or parsed.port not in (None, 80, 443):
            raise ValueError('请填写不含登录凭据的 HTTP 或 HTTPS 网站地址')
        try:
            address = ip_address(host)
        except ValueError:
            if '.' not in host or host.endswith(('.localhost', '.local', '.internal')):
                raise ValueError('请填写公开网站地址')
        else:
            if not address.is_global:
                raise ValueError('请填写公开网站地址')
        # Query parameters and fragments may contain login/session tokens.
        return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path or '/', '', ''))

    @model_validator(mode='after')
    def meaningful(self):
        if self.kind == 'website' and (not self.site_name or not self.url):
            raise ValueError('请填写网站名称和地址')
        if self.kind in ('plugin', 'uninstall') and (not self.comment or self.site_name or self.url):
            raise ValueError('请填写插件反馈内容')
        return self


class SupportRequestReceipt(BaseModel):
    id: str
    created_at: str


def receipt(row):
    return {'id': row.id, 'created_at': row.created_at.isoformat() + 'Z'}


def replay(row, request_hash):
    if row.request_hash != request_hash:
        problem('IDEMPOTENCY_CONFLICT', '此申请编号已用于其他内容', 409)
    return receipt(row)


@router.post('/v1/support-requests', response_model=SupportRequestReceipt, status_code=201)
def submit_support_request(body: SupportRequestBody, request: Request,
                        idempotency_key: Annotated[UUID, Header()], db: Session = Depends(get_db)):
    key, request_hash = str(idempotency_key), digest(body.model_dump())
    previous = db.scalar(select(SupportRequest).where(SupportRequest.idempotency_key == key))
    if previous:
        return replay(previous, request_hash)
    db.rollback()
    # Trust only ASGI's peer address (proxy trust is configured by the server).
    client_hash = sha256(('support-request:' + (request.client.host if request.client else 'unknown')).encode()).hexdigest()
    delay = redis_state.run('support', [redis_state.key('support', client_hash),
        redis_state.key('support-receipts', client_hash)], key)
    if delay:
        raise HTTPException(429, detail={'code': 'SUPPORT_REQUEST_RATE_LIMITED', 'message': '提交较频繁，请稍后重试',
            'retry_after_seconds': delay}, headers={'Retry-After': str(delay)})
    row = SupportRequest(**body.model_dump(), idempotency_key=key, request_hash=request_hash)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        previous = db.scalar(select(SupportRequest).where(SupportRequest.idempotency_key == key))
        if previous:
            return replay(previous, request_hash)
        raise
    return receipt(row)


@router.get('/v1/admin/support-requests')
def list_support_requests(kind: Literal['website', 'plugin', 'uninstall'], offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
                       user: User = Depends(admin), db: Session = Depends(get_db)):
    query = select(SupportRequest).where(SupportRequest.kind == kind)
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    rows = db.scalars(query.order_by(SupportRequest.created_at.desc(), SupportRequest.id.desc()).offset(offset).limit(limit))
    return {'items': [{**receipt(row), 'kind': row.kind, 'site_name': row.site_name, 'url': row.url, 'comment': row.comment, 'contact': row.contact} for row in rows],
            'total': total, 'next_offset': offset + limit if offset + limit < total else None}
