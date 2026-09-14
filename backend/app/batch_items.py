"""Request receipts and ordered batch references to potentially shared jobs."""
from sqlalchemy import CheckConstraint, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class BatchItem(Base):
    __tablename__ = "batch_items"
    batch_id: Mapped[str] = mapped_column(ForeignKey("batches.id"), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    input_asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"))
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
    __table_args__ = (CheckConstraint("ordinal >= 0"),)


class JobRequest(Base):
    __tablename__ = "job_requests"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    operation: Mapped[str] = mapped_column(String(100), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), index=True)
