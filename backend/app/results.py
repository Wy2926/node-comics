"""Shared generated versions and private grants; cache hits are not compute jobs."""
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, and_, literal, or_, select, union_all
from sqlalchemy.orm import Mapped, aliased, mapped_column
from .db import Base
from .models import Asset, Job, now, uid


class TranslationResult(Base):
    __tablename__ = 'translation_results'
    # Exactly one publication per real generation, including no-text outcomes.
    id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), primary_key=True)
    cache_key: Mapped[str] = mapped_column(String(64))
    generated_at: Mapped[datetime] = mapped_column(DateTime)
    __table_args__ = (Index('ix_results_content_generated', 'cache_key', 'generated_at', 'id'),)


class ResultAccess(Base):
    __tablename__ = 'result_accesses'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    result_id: Mapped[str] = mapped_column(ForeignKey('translation_results.id'))
    input_asset_id: Mapped[str] = mapped_column(ForeignKey('assets.id'), index=True)
    output_asset_id: Mapped[str | None] = mapped_column(ForeignKey('assets.id'), index=True)
    version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    change_sequence: Mapped[int] = mapped_column(BigInteger, default=0)
    __table_args__ = (UniqueConstraint('owner_id', 'result_id'),
        Index('ix_result_accesses_result', 'result_id'),
        Index('ix_result_accesses_owner_changes', 'owner_id', 'change_sequence'))


# Read-only reader projection. Only actual jobs are in the task history, queue,
# billing and admin tables. Keep the reader's existing page/result envelope.
_access_columns = {
    'id': ResultAccess.id, 'owner_id': ResultAccess.owner_id,
    'input_asset_id': ResultAccess.input_asset_id, 'output_asset_id': ResultAccess.output_asset_id,
    'version': ResultAccess.version, 'created_at': ResultAccess.created_at,
    'changed_at': ResultAccess.changed_at, 'change_sequence': ResultAccess.change_sequence,
    'completed_at': TranslationResult.generated_at,
}
_access_constants = {
    'input_pinned': False, 'file_hash': None, 'page_index': None,
    'priority_rank': 1000000, 'realtime_until': None, 'phase': 'completed',
    'idempotency_key': '', 'operation': 'result_access', 'request_hash': '',
    'config': {}, 'quota_pages': 0, 'quota_period_id': None,
    'entitlement': {}, 'settlement': 'free', 'attempt_id': None,
    'cancel_requested': False, 'discard_output': False, 'error_code': None,
    'error_message': None, 'unknown_since': None,
}
_access_select = select(*[
    (_access_columns[column.name] if column.name in _access_columns else
     literal(_access_constants[column.name], type_=column.type) if column.name in _access_constants else
     getattr(Job, column.name)).label(column.name)
    for column in Job.__table__.columns
], literal(True).label('cache_hit')
).select_from(ResultAccess).join(TranslationResult, TranslationResult.id == ResultAccess.result_id).join(
    Job, Job.id == TranslationResult.id)


class ReaderEntry(Base):
    __table__ = union_all(select(Job, literal(False).label('cache_hit')), _access_select).subquery('reader_entries')
    __mapper_args__ = {'primary_key': [__table__.c.id]}


def valid_asset_sql(asset):
    return and_(asset.id.is_not(None), asset.deleted_at.is_(None), asset.purged_at.is_(None),
        or_(asset.expires_at.is_(None), asset.expires_at > now(), asset.active_references > 0))


def publish_result(db, job):
    """Called in the delivery transaction, never on cache access or replay."""
    if job.status not in {'succeeded', 'no_text'} or job.cancel_requested or job.discard_output:
        return
    if db.get(TranslationResult, job.id):
        return
    db.add(TranslationResult(id=job.id, cache_key=job.cache_key, generated_at=job.completed_at))
    db.flush()


def shared_candidate(db, cache_key):
    """Indexed generated-version lookup; SQL filters tombstones before LIMIT.

    EXISTS avoids expanding one result into N user grants before sorting.
    The second lookup returns just one live pair of private image references.
    No remote object probes or per-candidate ORM queries.
    """
    source, output = aliased(Asset), aliased(Asset)
    live = select(ResultAccess.id).join(source, source.id == ResultAccess.input_asset_id).outerjoin(
        output, output.id == ResultAccess.output_asset_id).where(
        ResultAccess.result_id == TranslationResult.id, valid_asset_sql(source),
        or_(ResultAccess.output_asset_id.is_(None), valid_asset_sql(output)))
    original, translated = aliased(Asset), aliased(Asset)
    producer_live = and_(valid_asset_sql(original), or_(Job.status == 'no_text', valid_asset_sql(translated)))
    found = db.execute(select(TranslationResult.id, producer_live.label('producer_live')).join(
        Job, Job.id == TranslationResult.id).join(original, original.id == Job.input_asset_id).outerjoin(
        translated, translated.id == Job.output_asset_id).where(
        TranslationResult.cache_key == cache_key, or_(producer_live, live.exists())).order_by(
        TranslationResult.generated_at.desc(), TranslationResult.id.desc()).limit(1))
    row = found.first()
    if row is None:
        return None
    if row.producer_live:
        return (row.id, None)
    access_id = db.scalar(select(ResultAccess.id).join(source, source.id == ResultAccess.input_asset_id).outerjoin(
        output, output.id == ResultAccess.output_asset_id).where(ResultAccess.result_id == row.id,
        valid_asset_sql(source), or_(ResultAccess.output_asset_id.is_(None), valid_asset_sql(output))).limit(1))
    return (row.id, access_id) if access_id else None


def resolve_candidate(db, cache_key, candidate):
    """Constant-size lock-time recheck of an outside-lock hint."""
    from .assets import available
    if not candidate:
        return None
    result = db.get(TranslationResult, candidate[0], populate_existing=True)
    access = db.get(ResultAccess, candidate[1], populate_existing=True) if candidate[1] else db.get(Job, candidate[0], populate_existing=True)
    if not result or result.cache_key != cache_key or not access or (candidate[1] and access.result_id != result.id):
        return None
    source = db.get(Asset, access.input_asset_id, populate_existing=True)
    output = db.get(Asset, access.output_asset_id, populate_existing=True) if access.output_asset_id else None
    if not available(source) or (access.output_asset_id and not available(output)):
        return None
    return result, source, output


def get_entry(db, entry_id):
    return db.get(Job, entry_id) or db.get(ReaderEntry, entry_id)
