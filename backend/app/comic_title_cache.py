"""Shared input/output records. The generating user is attribution only."""
from contextlib import contextmanager
from datetime import datetime, timedelta
from hashlib import sha256
import logging
from threading import Event, Thread
import time
import unicodedata
from fastapi import HTTPException
from sqlalchemy import Boolean, DateTime, ForeignKey, String, case, delete, func, literal, or_, select, update
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base, session_factory
from .models import uid
from .translation_limits import server_now

WAIT_SECONDS = 10
LEASE_SECONDS = 210
HEARTBEAT_SECONDS = 30


class TitleRecord(Base):
    __tablename__ = 'comic_title_cache'
    input_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    language: Mapped[str] = mapped_column(String(35), primary_key=True)
    input_name: Mapped[str] = mapped_column(String(60))
    name: Mapped[str | None] = mapped_column(String(2000))
    output_key: Mapped[str | None] = mapped_column(String(64), index=True)
    actual_language: Mapped[str | None] = mapped_column(String(35))
    created_by: Mapped[str | None] = mapped_column(ForeignKey('users.id'))
    ready: Mapped[bool] = mapped_column(Boolean, default=False)
    token: Mapped[str | None] = mapped_column(String(36), unique=True, index=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime)


def name_key(name):
    return sha256(unicodedata.normalize('NFC', name.strip()).encode('utf-8')).hexdigest()


def related_results(key, language):
    # Follow only exact names already connected by an LLM result. UNION removes
    # cycles; this is a read-only lookup, with no comic entities or group merges.
    names = select(literal(key).cast(String(64)).label('key')).cte('names', recursive=True)
    other = case((TitleRecord.input_key == names.c.key, TitleRecord.output_key), else_=TitleRecord.input_key)
    names = names.union(select(other).join(names, or_(TitleRecord.input_key == names.c.key,
        TitleRecord.output_key == names.c.key)).where(TitleRecord.ready.is_(True), TitleRecord.output_key.is_not(None)))
    return (select(TitleRecord.name, TitleRecord.actual_language).join(names, TitleRecord.input_key == names.c.key)
        .where(TitleRecord.ready.is_(True), or_(TitleRecord.language == language,
            func.lower(TitleRecord.actual_language) == language))
        .distinct().order_by(TitleRecord.name.asc().nulls_last(), TitleRecord.actual_language).limit(2))


def find_related(db, key, language):
    rows = db.execute(related_results(key, language)).all()
    positive = [row for row in rows if row.name is not None]
    if len(positive) == 1:
        return {'name': positive[0].name, 'target_language': positive[0].actual_language}
    if rows and not positive:
        return {'name': None, 'target_language': None}
    # Conflicting names require the LLM; never pick an arbitrary cached record.
    return None


def lookup_or_claim(name, language):
    deadline, delay = time.monotonic() + WAIT_SECONDS, 0.1
    key, language = name_key(name), language.lower()
    while True:
        with session_factory()() as db:
            row = db.get(TitleRecord, (key, language))
            if row is not None and row.ready:
                return {'name': row.name, 'target_language': row.actual_language}, None
            cached = find_related(db, key, language)
            if cached is not None:
                return cached, None
            at = server_now(db)
            pending = row is not None and row.lease_until is not None and row.lease_until > at
        if not pending:
            # A single indexed upsert claims this input/language across processes.
            # No user ID or global lock participates in lookup or deduplication.
            with session_factory()() as db:
                if db.get_bind().dialect.name == 'postgresql':
                    from sqlalchemy.dialects.postgresql import insert
                else:
                    from sqlalchemy.dialects.sqlite import insert
                at, token = server_now(db), uid()
                stmt = insert(TitleRecord).values(input_key=key, language=language,
                    input_name=name.strip(), ready=False, token=token, lease_until=at + timedelta(seconds=LEASE_SECONDS))
                claimed = db.scalar(stmt.on_conflict_do_update(index_elements=['input_key', 'language'],
                    set_={'token': token, 'lease_until': at + timedelta(seconds=LEASE_SECONDS)},
                    where=TitleRecord.ready.is_(False) & (TitleRecord.lease_until <= at))
                    .returning(TitleRecord.token))
                db.commit()
                if claimed:
                    return None, claimed
        if time.monotonic() >= deadline:
            raise HTTPException(503, detail={'code': 'COMIC_TITLE_PENDING',
                'message': '相同漫画名正在查询，请稍后重试', 'retry_after_seconds': 1},
                headers={'Retry-After': '1'})
        time.sleep(min(delay, max(0, deadline - time.monotonic())))
        delay = min(1, delay * 2)


def renew_claim(claim):
    with session_factory()() as db:
        at = server_now(db)
        renewed = db.execute(update(TitleRecord).where(TitleRecord.token == claim,
            TitleRecord.ready.is_(False), TitleRecord.lease_until > at).values(
                lease_until=at + timedelta(seconds=LEASE_SECONDS))).rowcount == 1
        db.commit()
        return renewed


@contextmanager
def maintain_claim(claim):
    if not renew_claim(claim):
        raise HTTPException(503, detail={'code': 'COMIC_TITLE_LEASE_LOST',
            'message': '漫画名查询执行已失效，请稍后重试'})
    stopped = Event()

    def heartbeat():
        while not stopped.wait(HEARTBEAT_SECONDS):
            try:
                if not renew_claim(claim):
                    return
            except Exception as error:
                # No SQL parameters, titles or provider responses in logs.
                logging.getLogger(__name__).warning('Comic title lease renewal failed: %s', type(error).__name__)

    thread = Thread(target=heartbeat, name='comic-title-heartbeat', daemon=True)
    thread.start()
    try:
        yield
    finally:
        stopped.set()
        thread.join()


def save_result(owner_id, claim, result):
    with session_factory()() as db:
        saved = db.execute(update(TitleRecord).where(TitleRecord.token == claim,
            TitleRecord.ready.is_(False), TitleRecord.lease_until > server_now(db)).values(
            ready=True, name=result.name, actual_language=result.target_language,
            output_key=name_key(result.name) if result.name is not None else None,
            created_by=owner_id, token=None, lease_until=None)).rowcount == 1
        db.commit()
        return saved


def release_claim(claim):
    with session_factory()() as db:
        db.execute(delete(TitleRecord).where(TitleRecord.token == claim))
        db.commit()
