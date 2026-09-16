"""Durable progress reports for independently supervised control processes."""
from datetime import datetime
from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


class ServiceHeartbeat(Base):
    __tablename__ = "service_heartbeats"
    role: Mapped[str] = mapped_column(String(30), primary_key=True)
    instance_id: Mapped[str] = mapped_column(String(200), primary_key=True)
    heartbeat_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(80))
