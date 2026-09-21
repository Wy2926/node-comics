"""Append-only operator history, committed with the business mutation."""
from datetime import datetime, timezone
import hashlib
import json
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Query
from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, UniqueConstraint, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from .auth import admin
from .db import Base, get_db
from .errors import problem
from .models import User, now, uid


class AdminAudit(Base):
    __tablename__ = 'admin_audit_events'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    actor_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    action: Mapped[str] = mapped_column(String(100))
    target_type: Mapped[str] = mapped_column(String(60))
    target_id: Mapped[str] = mapped_column(String(320))
    operation_key: Mapped[str | None] = mapped_column(String(64))
    before: Mapped[dict | list | None] = mapped_column(JSON)
    after: Mapped[dict | list | None] = mapped_column(JSON)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    note: Mapped[str] = mapped_column(String(500), default='')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint('operation_key'),
        Index('ix_admin_audit_created', 'created_at', 'id'),
        Index('ix_admin_audit_target', 'target_type', 'target_id', 'created_at'),
        Index('ix_admin_audit_actor', 'actor_id', 'created_at'))


_PRIVATE = ('secret', 'password', 'credential', 'authorization', 'cookie', 'api_key',
            'apikey', 'token', 'signed_url', 'storage_key', 'output_key', 'return_url',
            'checkout_url', 'analysis', 'translations', 'payload', 'image_bytes')
# These public configuration/usage fields are integer counts, never credentials.
# Unknown token-like keys and unexpected value types must remain redacted.
_PUBLIC_TOKEN_COUNTS = frozenset(('max_output_tokens', 'input_tokens', 'output_tokens'))


def sanitize(value, *, depth=0):
    """Defense in depth; callers must pass purpose-built metadata snapshots."""
    if depth > 8:
        return '[omitted]'
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:100]:
            name = str(key)
            public_count = name.lower() in _PUBLIC_TOKEN_COUNTS and type(item) is int and item >= 0
            private = any(part in name.lower() for part in _PRIVATE) and not public_count
            result[name[:100]] = '[redacted]' if private else sanitize(item, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [sanitize(item, depth=depth + 1) for item in value[:100]]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        if value.startswith(('https://', 'http://')):
            parsed = urlsplit(value)
            value = urlunsplit((parsed.scheme, parsed.netloc.split('@')[-1], parsed.path, '', ''))
        return value[:2000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return '[omitted]'


def audit_operation_key(actor_id, action, target_type, target_id, operation_key):
    return hashlib.sha256(json.dumps([actor_id, action, target_type, str(target_id), operation_key],
        ensure_ascii=True).encode()).hexdigest()


def find_audit_operation(db, actor_id, action, target_type, target_id, operation_key):
    return db.scalar(select(AdminAudit).where(AdminAudit.operation_key ==
        audit_operation_key(actor_id, action, target_type, target_id, operation_key)))


def record_audit(db, actor_id, action, target_type, target_id, *, before=None, after=None,
                 details=None, note='', operation_key=None):
    """Never commit here: failed/rolled-back mutations must not look successful."""
    key = audit_operation_key(actor_id, action, target_type, target_id, operation_key) if operation_key else None
    values = dict(id=uid(), actor_id=actor_id, action=action, target_type=target_type,
        target_id=str(target_id), operation_key=key, before=sanitize(before), after=sanitize(after),
        details=sanitize(details or {}), note=note[:500], created_at=now())
    # DB uniqueness, rather than a check-then-insert, protects duplicate requests.
    if key:
        if db.get_bind().dialect.name == 'postgresql':
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        db.execute(insert(AdminAudit).values(**values).on_conflict_do_nothing(index_elements=['operation_key']))
    else:
        db.add(AdminAudit(**values))
    return values['id']


router = APIRouter(prefix='/v1/admin/audit', dependencies=[Depends(admin)])


@router.get('')
def audit_events(actor_id: str | None = Query(None, max_length=36),
        action: str | None = Query(None, max_length=100), target_type: str | None = Query(None, max_length=60),
        target_id: str | None = Query(None, max_length=320), created_from: datetime | None = None,
        created_to: datetime | None = None, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
        db: Session = Depends(get_db)):
    start = created_from.astimezone(timezone.utc).replace(tzinfo=None) if created_from and created_from.tzinfo else created_from
    end = created_to.astimezone(timezone.utc).replace(tzinfo=None) if created_to and created_to.tzinfo else created_to
    if start and end and start > end:
        problem('DATE_RANGE_INVALID', '开始时间不能晚于结束时间', 422)
    query = select(AdminAudit, User.name).join(User, User.id == AdminAudit.actor_id)
    for column, value in ((AdminAudit.actor_id, actor_id), (AdminAudit.action, action),
                          (AdminAudit.target_type, target_type), (AdminAudit.target_id, target_id)):
        if value:
            query = query.where(column == value)
    if start:
        query = query.where(AdminAudit.created_at >= start)
    if end:
        query = query.where(AdminAudit.created_at <= end)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(query.order_by(AdminAudit.created_at.desc(), AdminAudit.id.desc()).offset(offset).limit(limit))
    fields = ('id', 'actor_id', 'action', 'target_type', 'target_id', 'before', 'after', 'details', 'note', 'created_at')
    return {'items': [{**{field: getattr(row, field) for field in fields}, 'actor_name': name} for row, name in rows],
            'total': total, 'next_offset': offset + limit if offset + limit < total else None}
