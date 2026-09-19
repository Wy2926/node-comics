"""Upload receipts share the parent job's capacity and quota reservation."""
from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class UploadReservation(Base):
    __tablename__ = "upload_reservations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True, index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    mode: Mapped[str] = mapped_column(String(20))
    expected_sha256: Mapped[str] = mapped_column(String(64))
    expected_size: Mapped[int] = mapped_column(Integer)
    mime: Mapped[str] = mapped_column(String(30))
    storage_backend: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(24), default="awaiting_upload", index=True)
    asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    max_expires_at: Mapped[datetime] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    error_code: Mapped[str | None] = mapped_column(String(60))
    error_message: Mapped[str | None] = mapped_column(String(300))
    verified_info: Mapped[dict | None] = mapped_column(JSON)
    __table_args__ = (CheckConstraint("expected_size > 0"),)


class UploadIngressMutex(Base):
    __tablename__ = "upload_ingress_mutex"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)


class UploadIngressLease(Base):
    __tablename__ = "upload_ingress_leases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    upload_id: Mapped[str] = mapped_column(ForeignKey("upload_reservations.id"), unique=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
