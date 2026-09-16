"""A bounded feedback admission record shared by every API replica."""
from datetime import datetime
from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class FeedbackAdmission(Base):
    __tablename__ = "feedback_admissions"
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    request_tokens: Mapped[float] = mapped_column(Float)
    refilled_at: Mapped[datetime] = mapped_column(DateTime)
    day_started_at: Mapped[datetime] = mapped_column(DateTime)
    daily_receipts: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (CheckConstraint("daily_receipts >= 0", name="ck_feedback_admissions_daily_receipts"),)
