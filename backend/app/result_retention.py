"""Image result expiry shared by reads, reuse and bounded maintenance."""
from datetime import timedelta
from sqlalchemy import select, text, update
from .models import Asset, Job, now, IMAGE_RESULT_EXPIRY_FILTER
from .system_settings import get_request_limits
from .translation_requests import TranslationRequest


def result_expires_at(db, job, *, days=None):
    if not job or job.workflow_kind != 'image' or not job.completed_at:
        return None
    if job.quota_kind == 'guest_trial':
        return job.completed_at + timedelta(hours=24)
    if job.status not in {'succeeded', 'no_text'}:
        return None
    days = days if days is not None else get_request_limits(db).image_result_retention_days
    return job.completed_at + timedelta(days=days)


def result_expired(db, job, *, days=None, at=None):
    # Cleanup is irreversible even if an administrator later extends retention.
    if job and job.error_code == 'RESULT_EXPIRED':
        return True
    deadline = result_expires_at(db, job, days=days)
    return deadline is not None and deadline <= (at or now())


def expire_registered_results(db):
    """Caller holds the scheduler lock; commit revocation before unlinking files."""
    at = now()
    cutoff = at - timedelta(days=get_request_limits(db).image_result_retention_days)
    jobs = db.scalars(select(Job).where(text(IMAGE_RESULT_EXPIRY_FILTER), Job.completed_at <= cutoff)
        .order_by(Job.completed_at, Job.id).limit(100))
    for job in jobs:
        job.discard_output = True
        job.error_code, job.error_message = 'RESULT_EXPIRED', '译图已过期，请手动重新翻译'
        db.execute(update(TranslationRequest).where(TranslationRequest.job_id == job.id,
            TranslationRequest.revoked_at.is_(None)).values(revoked_at=at))
        if job.output_asset_id:
            output = db.get(Asset, job.output_asset_id)
            if output:
                output.deleted_at = output.deleted_at or at
