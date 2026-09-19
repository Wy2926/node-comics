"""Durable per-image operations and bounded reading coordination."""
from datetime import datetime
from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now


class TranslationOperation(Base):
    __tablename__ = 'translation_operations'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    operation_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), index=True)
    descriptor: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (Index('ix_translation_operations_owner_created', 'owner_id', 'created_at'),)


class ImageAdmission(Base):
    __tablename__ = 'image_admissions'
    job_id: Mapped[str] = mapped_column(ForeignKey('jobs.id'), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    admitted_at: Mapped[datetime] = mapped_column(DateTime)
    __table_args__ = (Index('ix_image_admissions_owner_time', 'owner_id', 'admitted_at'),)


class ReadingSession(Base):
    __tablename__ = 'reading_sessions'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    sequence: Mapped[int] = mapped_column(Integer, default=-1)
    window_hash: Mapped[str] = mapped_column(String(64), default='')
    window: Mapped[list] = mapped_column(JSON, default=list)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    fenced: Mapped[bool] = mapped_column(default=False)


class TranslationPolicy(Base):
    __tablename__ = 'translation_policies'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    fingerprint: Mapped[str] = mapped_column(String(64), default='')


class ControlAdmission(Base):
    __tablename__ = 'control_admissions'
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    scope: Mapped[str] = mapped_column(String(24), primary_key=True)
    tokens: Mapped[float] = mapped_column(Float)
    refilled_at: Mapped[datetime] = mapped_column(DateTime)
    leases: Mapped[list] = mapped_column(JSON, default=list)
