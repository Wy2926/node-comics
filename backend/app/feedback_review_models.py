"""Append-only administrative feedback decisions and durable replay receipts."""
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .models import now, uid


class FeedbackReview(Base):
    __tablename__ = "translation_feedback_reviews"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    feedback_id: Mapped[str] = mapped_column(ForeignKey("translation_feedback.id"))
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    operation_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    from_status: Mapped[str] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(500))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint("actor_id", "operation_key"),
                     Index("ix_feedback_reviews_feedback_created", "feedback_id", "created_at", "id"))
