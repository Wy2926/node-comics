"""Document manifests and central text receipts; page files stay on their owner."""
from datetime import datetime
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from ..db import Base
from ..models import now, uid


class Document(Base):
    __tablename__ = 'documents'
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), primary_key=True)
    filename: Mapped[str] = mapped_column(String(240))
    source_type: Mapped[str] = mapped_column(String(8))
    source_key: Mapped[str] = mapped_column(String(300), unique=True)
    upload_id: Mapped[str | None] = mapped_column(String(1024))
    source_size: Mapped[int] = mapped_column(Integer)
    source_sha256: Mapped[str] = mapped_column(String(64))
    page_count: Mapped[int | None] = mapped_column(Integer)
    manifest_sha256: Mapped[str | None] = mapped_column(String(64))
    upload_completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reserved_at: Mapped[datetime | None] = mapped_column(DateTime)
    owner_node_id: Mapped[str | None] = mapped_column(ForeignKey('compute_nodes.id'), index=True)
    workspace_generation: Mapped[int] = mapped_column(Integer, default=1, server_default='1')
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    output_ref: Mapped[dict | None] = mapped_column(JSON)
    text_input_ref: Mapped[dict | None] = mapped_column(JSON)
    text_output_ref: Mapped[dict | None] = mapped_column(JSON)
    text_input_payload: Mapped[dict | None] = mapped_column(JSON, deferred=True)
    text_output_payload: Mapped[dict | None] = mapped_column(JSON, deferred=True)
    text_request_sha256: Mapped[str | None] = mapped_column(String(64))
    text_call_id: Mapped[str | None] = mapped_column(ForeignKey('text_calls.id'))
    text_state: Mapped[str] = mapped_column(String(24), default='pending')
    cleanup_after: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (
        CheckConstraint("source_type IN ('zip', 'pdf')", name='ck_document_type'),
        CheckConstraint('source_size > 0 AND source_size <= 200000000', name='ck_document_size'),
        CheckConstraint('page_count IS NULL OR page_count BETWEEN 1 AND 200', name='ck_document_pages'),
        CheckConstraint('workspace_generation >= 1', name='ck_document_workspace_generation'),
    )


class DocumentQuotaAllocation(Base):
    __tablename__ = 'document_quota_allocations'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey('documents.job_id'), index=True)
    period_id: Mapped[str | None] = mapped_column(ForeignKey('quota_periods.id'), index=True)
    billing_term_id: Mapped[str | None] = mapped_column(ForeignKey('billing_terms.id'))
    entitlement: Mapped[dict] = mapped_column(JSON)
    pages: Mapped[int] = mapped_column(Integer)
    reserved: Mapped[int] = mapped_column(Integer)
    used: Mapped[int] = mapped_column(Integer, default=0)
    released: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (
        UniqueConstraint('job_id', 'period_id', name='uq_document_period'),
        UniqueConstraint('job_id', 'billing_term_id', name='uq_document_unlimited_term'),
        UniqueConstraint('id', 'job_id', name='uq_document_allocation_job'),
        CheckConstraint('(period_id IS NOT NULL AND billing_term_id IS NULL) OR '
                        '(period_id IS NULL AND billing_term_id IS NOT NULL)', name='ck_document_allocation_source'),
        CheckConstraint('pages BETWEEN 1 AND 200 AND reserved >= 0 AND used >= 0 AND released >= 0 '
                        'AND pages = reserved + used + released', name='ck_document_allocation_balance'),
    )


class DocumentPage(Base):
    __tablename__ = 'document_pages'
    job_id: Mapped[str] = mapped_column(ForeignKey('documents.job_id'), primary_key=True)
    page_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    allocation_id: Mapped[str | None] = mapped_column(String(36))
    source_name: Mapped[str] = mapped_column(String(300), default='')
    input_ref: Mapped[dict | None] = mapped_column(JSON)
    analysis_ref: Mapped[dict | None] = mapped_column(JSON)
    text_ref: Mapped[dict | None] = mapped_column(JSON, deferred=True)
    translations_ref: Mapped[dict | None] = mapped_column(JSON, deferred=True)
    output_ref: Mapped[dict | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default='pending')
    quality_flags: Mapped[list] = mapped_column(JSON, default=list)
    billable: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (
        ForeignKeyConstraint(['allocation_id', 'job_id'],
                             ['document_quota_allocations.id', 'document_quota_allocations.job_id']),
        CheckConstraint('page_index BETWEEN 1 AND 200', name='ck_document_page_index'),
        Index('ix_document_pages_status', 'job_id', 'status'),
    )
