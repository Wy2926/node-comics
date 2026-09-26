"""Rolling title-query admission history, independent of execution leases."""
from datetime import datetime, timedelta
from math import ceil
from fastapi import HTTPException
from sqlalchemy import ForeignKey, JSON, select
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base, session_factory
from .translation_limits import server_now

WINDOW_SECONDS = 60
REQUEST_LIMIT = 30


class TitleAdmission(Base):
    __tablename__ = 'comic_title_admissions'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    request_times: Mapped[list] = mapped_column(JSON, default=list)


def active_times(row, at):
    cutoff = (at - timedelta(seconds=WINDOW_SECONDS)).isoformat()
    return [value for value in row.request_times if value > cutoff] if row else []


def retry_after(times, at):
    return max(1, ceil((datetime.fromisoformat(min(times)) + timedelta(seconds=WINDOW_SECONDS) - at).total_seconds())) if len(times) >= REQUEST_LIMIT else 0


def title_budget(db, owner_id):
    row = db.get(TitleAdmission, owner_id)
    at = server_now(db)
    times = active_times(row, at)
    last_request_at = max(row.request_times, default=None) if row else None
    return {'window_seconds': WINDOW_SECONDS, 'limit': REQUEST_LIMIT, 'used': len(times),
        'remaining': max(0, REQUEST_LIMIT - len(times)), 'retry_after_seconds': retry_after(times, at),
        'last_request_at': last_request_at + 'Z' if last_request_at else None}


def admit_title(owner_id):
    with session_factory()() as db:
        if db.get_bind().dialect.name == 'postgresql':
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        db.execute(insert(TitleAdmission).values(owner_id=owner_id, request_times=[]).on_conflict_do_nothing())
        row = db.scalar(select(TitleAdmission).where(TitleAdmission.owner_id == owner_id).with_for_update())
        at = server_now(db)
        times = active_times(row, at)
        retry = retry_after(times, at)
        if retry:
            raise HTTPException(429, detail={'code': 'COMIC_TITLE_RATE_LIMITED',
                'message': '漫画名翻译每分钟最多调用 30 次', 'retry_after_seconds': retry},
                headers={'Retry-After': str(retry)})
        row.request_times = [*times, at.isoformat()]
        db.commit()
