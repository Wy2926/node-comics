"""Readiness follows completed work loops, never mere process existence.

No object-store or provider probes run from health requests. Exception values,
SQL arguments, request bodies and URLs are deliberately excluded from reports.
"""
import argparse
from datetime import timedelta
import logging
import os
import re
import socket
import traceback
from sqlalchemy import and_, delete, func, select, text
from .config import settings
from .db import session_factory
from .health_models import ServiceHeartbeat
from .models import Job, now
from .queue_models import ComputeNode, ExecutionLease, JobStage, UserModeQueue

ROLES = ("control-worker", "maintenance")
REPORT_ROLES = (*ROLES, "oidc")
log = logging.getLogger("node_comics.health")


def instance_id(pid=None):
    return f"{socket.gethostname()}:{os.getpid() if pid is None else pid}"[:200]


def error_code(error):
    value = getattr(error, "code", None)
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", value) else type(error).__name__[:80]


def log_failure(role, error, *, job_id=None, stage=None, lease_id=None):
    # Stack locations support diagnosis without copying potentially sensitive
    # exception messages or source statements into the default logs.
    frames = traceback.extract_tb(error.__traceback__)[-8:]
    locations = ",".join(f"{os.path.basename(frame.filename)}:{frame.lineno}:{frame.name}" for frame in frames)
    scope = " ".join(f"{key}={value}" for key, value in (("job_id", job_id), ("stage", stage), ("lease_id", lease_id))
                     if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value))
    log.error("service_failure role=%s error_code=%s %s locations=%s", role, error_code(error), scope, locations)


def report_progress(role, *, error=None, instance=None):
    if role not in REPORT_ROLES:
        raise ValueError("Unknown service role")
    at, identity = now(), instance or instance_id()
    with session_factory()() as db:
        row = db.get(ServiceHeartbeat, (role, identity))
        if row is None:
            row = ServiceHeartbeat(role=role, instance_id=identity, heartbeat_at=at,
                                   consecutive_failures=0, failure_count=0)
            db.add(row)
        row.heartbeat_at = at
        if error is None:
            row.last_success_at, row.consecutive_failures = at, 0
        else:
            row.consecutive_failures += 1
            row.failure_count += 1
            row.last_error_code = error_code(error)
        db.execute(delete(ServiceHeartbeat).where(ServiceHeartbeat.heartbeat_at < at - timedelta(days=7)))
        db.commit()


def report_failure(role, error):
    log_failure(role, error)
    try:
        report_progress(role, error=error)
    except Exception as reporting_error:
        # A database outage must not terminate the worker's recovery loop.
        log_failure(role + "-heartbeat", reporting_error)


def _current(row, deadline):
    return bool(row and row.last_success_at and row.last_success_at > deadline and row.consecutive_failures == 0)


def probe_oidc():
    """Maintenance-only public JWKS probe; no tokens or private identity data."""
    if settings().dev_auth:
        return
    from .auth import jwks_client
    try:
        jwks_client().get_signing_keys(refresh=True)
        report_progress("oidc")
    except Exception as error:
        report_failure("oidc", error)


def queue_alerts(db):
    cfg, at = settings(), now()
    threshold = max(cfg.classic_timeout_seconds, cfg.provider_timeout_seconds, cfg.cluster_node_timeout_seconds * 3)
    cutoff = at - timedelta(seconds=threshold)

    def count(statement):
        return db.scalar(select(func.count()).select_from(statement.limit(1000).subquery()))

    # These are alert signals rather than proof that the whole API is unusable.
    # Count at most 1000 matches per query
    # without loading jobs into the ORM or acquiring the scheduler lock.
    overdue = select(JobStage.id).join(Job, Job.id == JobStage.job_id).where(
        JobStage.status == "ready", JobStage.available_at < cutoff, Job.status.in_(["queued", "running"]),
        Job.cancel_requested.is_(False))
    return {"outcome_unknown": count(select(Job.id).where(Job.status == "outcome_unknown")),
            "unknown_released": count(select(Job.id).where(Job.status == "unknown_released")),
            "overdue_ready_stages": count(overdue),
            "expired_leases": count(select(ExecutionLease.id).where(ExecutionLease.completed_at.is_(None), ExecutionLease.expires_at < at)),
            "overdue_after_seconds": threshold, "count_limit": 1000}


def readiness(*, role=None, instance=None):
    """Return bounded, non-sensitive dependency state and an HTTP-ready flag."""
    checks = {"database": "unavailable"}
    alerts = {}
    try:
        deadline = now() - timedelta(seconds=settings().cluster_node_timeout_seconds)
        with session_factory()() as db:
            db.execute(text("SELECT 1"))
            checks["database"] = "ready"
            required_roles = (*ROLES, "oidc") if not settings().dev_auth else ROLES
            for required in (role,) if role else required_roles:
                statement = select(ServiceHeartbeat).where(ServiceHeartbeat.role == required)
                if instance:
                    statement = statement.where(ServiceHeartbeat.instance_id == instance)
                rows = db.scalars(statement.where(ServiceHeartbeat.heartbeat_at > deadline)).all()
                checks[required] = "ready" if any(_current(row, deadline) for row in rows) else "unavailable"
            if role is None:
                # Pool configuration can intentionally disable a mode; it does
                # not remove the requirement for a live control executor.
                pools = db.scalars(select(ComputeNode).where(ComputeNode.id.in_(
                    ["control-text", "control-redraw", "control-validate_upload"]))).all()
                checks["control-pools"] = "ready" if len(pools) == 3 and all(
                    node.heartbeat_at and node.heartbeat_at > deadline for node in pools) else "unavailable"
                if settings().classic_enabled:
                    online = db.scalar(select(ComputeNode.id).where(ComputeNode.enabled.is_(True),
                        ComputeNode.engine_version == settings().classic_engine_version,
                        ComputeNode.applied_config_version == ComputeNode.config_version,
                        ComputeNode.config_error.is_(None), ComputeNode.heartbeat_at > deadline).limit(1))
                    checks["compute-nodes"] = "ready" if online else "unavailable"
                alerts = queue_alerts(db)
    except Exception as error:
        log_failure("readiness", error)
        checks["database"] = "unavailable"
    ready = all(value == "ready" for value in checks.values())
    return {"status": "ready" if ready else "unavailable", "checks": checks, "alerts": alerts}, ready


def main():
    parser = argparse.ArgumentParser(description="Check this container's durable progress heartbeat")
    parser.add_argument("role", choices=ROLES)
    parser.add_argument("--pid", type=int, default=1)
    args = parser.parse_args()
    payload, ready = readiness(role=args.role, instance=instance_id(args.pid))
    print(payload["status"])
    raise SystemExit(0 if ready else 1)


if __name__ == "__main__":
    main()
