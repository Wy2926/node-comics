"""One durable submission protocol for uploaded, reusable and regenerated pages."""
from collections import Counter, defaultdict
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import Field, model_validator
from sqlalchemy import and_, func, or_, select, tuple_
from sqlalchemy.orm import Session, aliased
from starlette.concurrency import run_in_threadpool
from .assets import available, find_shared_original, owned_asset
from .auth import identity
from .config import settings
from .db import get_db
from .entitlements import locked_user
from .errors import problem
from .file_pages import FilePage
from .languages import Language
from .jobs import submission_status, cancel_job, create_job, idem_key, job_json, owned_job
from .models import Asset, Job, User, now
from .providers import configuration, digest
from .queue_models import JobStage, Submission, SubmissionItem
from .request_models import RequestBody
from .scheduler import ACTIVE, active_count, limits_for, lock_scheduler, queue_for, touch_job
from .submission_limits import acquire_submission, release_submission
from .upload_models import UploadReservation
from .uploads import create_upload, fail_upload, owned_upload, read_upload_stream, receive_upload, upload_json

router = APIRouter(tags=["submissions"])


class ItemRequest(RequestBody):
    client_item_id: str = Field(min_length=1, max_length=100)
    image_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    byte_size: int = Field(gt=0)
    content_type: str = Field(max_length=60)
    name: str = Field(default="", max_length=255)
    file_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    page_index: int | None = Field(default=None, ge=0, le=1000000)
    asset_id: str | None = None

    @model_validator(mode="after")
    def source_pair(self):
        if (self.file_hash is None) != (self.page_index is None):
            raise ValueError("文件身份字段必须配对")
        return self


class SubmissionRequest(RequestBody):
    mode: Literal["classic", "redraw"]
    target_language: Language
    max_quota_pages: int = Field(ge=0, le=1000000)
    expected_kind: str | None = None
    regenerate: bool = False
    rerun_job_id: str | None = None
    acknowledge_unknown_cost: bool = False
    reading_session_id: str | None = Field(default=None, max_length=80)
    items: list[ItemRequest] = Field(min_length=1, max_length=500)


def owned_submission(db, submission_id, owner_id):
    row = db.get(Submission, submission_id)
    if not row or row.owner_id != owner_id:
        problem("NOT_FOUND", "找不到此提交清单", 404)
    if row.archived_at:
        problem("SUBMISSION_ARCHIVED", "提交回执已归档，请从任务记录查询结果", 410)
    return row


def submission_json(db, row):
    items = db.execute(select(SubmissionItem, Job).join(Job, Job.id == SubmissionItem.job_id)
        .where(SubmissionItem.submission_id == row.id).order_by(SubmissionItem.ordinal)).all()
    job_ids = [j.id for _, j in items]
    uploads = {r.job_id: r for r in db.scalars(select(UploadReservation).where(UploadReservation.job_id.in_(job_ids)))} if job_ids else {}
    return {"id": row.id, "mode": row.mode, "target_language": row.target_language,
        "created_at": row.created_at.isoformat() + "Z", "quota_pages": row.quota_pages,
        "status": submission_status([j for _, j in items]), "page_count": len(items),
        "items": [{"client_item_id": item.client_item_id, "reused": item.reused,
            "job": job_json(db, job, submission_id=row.id, ordinal=item.ordinal),
            "upload": upload_json(uploads[job.id]) if job.id in uploads and uploads[job.id].status in {"awaiting_upload", "uploaded"} else None}
            for item, job in items]}


def bind_file_page(db, job, *, submission_id=None):
    if not job.input_asset_id:
        return
    identities = {(job.file_hash, job.page_index)} if job.file_hash and job.page_index is not None else set()
    # A verified source only needs this submission's new page identities. Upload
    # completion must bind every receipt that shared the pending upload.
    statement = select(SubmissionItem).where(SubmissionItem.job_id == job.id)
    if submission_id is not None:
        statement = statement.where(SubmissionItem.submission_id == submission_id)
    for item in db.scalars(statement):
        descriptor = item.descriptor
        if descriptor.get("file_hash") and descriptor.get("page_index") is not None:
            identities.add((descriptor["file_hash"], descriptor["page_index"]))
    for file_hash, page_index in sorted(identities):
        key = (job.owner_id, file_hash, page_index)
        existing = db.get(FilePage, key)
        if not existing:
            db.add(FilePage(owner_id=job.owner_id, file_hash=file_hash, page_index=page_index, asset_id=job.input_asset_id))
        else:
            source = db.get(Asset, existing.asset_id)
            if not available(source) or source.sha256 == job.source_sha256:
                existing.asset_id = job.input_asset_id
            else:
                problem("FILE_PAGE_CONFLICT", "同一文件页已绑定不同原图", 409)


@router.post("/v1/translation-submissions", status_code=202)
def submit(body: SubmissionRequest, idempotency_key: Annotated[str | None, Header()] = None,
           user: User = Depends(identity), db: Session = Depends(get_db)):
    key = idem_key(idempotency_key)
    owner_id = user.id
    # The admission transaction must finish before waiting on the scheduler;
    # release the identity dependency's read transaction as well (SQLite WAL).
    db.rollback()
    token = acquire_submission(owner_id, key, len(body.items))
    try:
        return _submit(body, key, db.get(User, owner_id), db)
    finally:
        db.rollback()
        release_submission(owner_id, token)


def _submit(body, key, user, db):
    lock_scheduler(db)
    user = locked_user(db, user.id)
    request_hash = digest(body.model_dump())
    previous = db.scalar(select(Submission).where(Submission.owner_id == user.id, Submission.idempotency_key == key))
    if previous:
        if previous.request_hash != request_hash:
            problem("IDEMPOTENCY_CONFLICT", "此操作编号已绑定其他提交内容", 409)
        if previous.archived_at:
            problem("SUBMISSION_ARCHIVED", "提交回执已归档；此操作编号不会再次执行", 410)
        return submission_json(db, previous)
    if len(body.items) > settings().max_batch or len({i.client_item_id for i in body.items}) != len(body.items):
        problem("INVALID_BATCH", "提交页数超限或页面编号重复", 422)
    if body.regenerate:
        if len(body.items) != 1 or not body.rerun_job_id:
            problem("RERUN_SOURCE_REQUIRED", "重新翻译必须指定原任务及单页", 422)
        original = owned_job(db, body.rerun_job_id, user.id)
        if original.mode != body.mode or original.source_sha256 != body.items[0].image_sha256 or original.target_language != body.target_language:
            problem("RERUN_SOURCE_MISMATCH", "重译必须使用原任务相同页面、模式与语言", 409)
        if original.status in {"outcome_unknown", "unknown_released"} and not body.acknowledge_unknown_cost:
            problem("UNKNOWN_COST_ACK_REQUIRED", "原请求可能已产生费用，需明确确认后重译", 409)
    config = configuration(db, body.mode, body.target_language)
    declared_pages = {}
    for item in body.items:
        if not item.file_hash:
            continue
        identity_key = (item.file_hash, item.page_index)
        if identity_key in declared_pages and declared_pages[identity_key] != item.image_sha256:
            problem("FILE_PAGE_CONFLICT", "同一文件页不能提交不同原图", 409)
        declared_pages[identity_key] = item.image_sha256
    if declared_pages:
        file_column = SubmissionItem.descriptor["file_hash"].as_string()
        page_column = SubmissionItem.descriptor["page_index"].as_integer()
        pending_pages = db.execute(select(file_column, page_column, Job.source_sha256)
            .join(Job, Job.id == SubmissionItem.job_id).where(Job.owner_id == user.id, Job.status.in_(ACTIVE),
                tuple_(file_column, page_column).in_(declared_pages)).distinct())
        for file_hash, page_index, source_hash in pending_pages:
            if declared_pages[(file_hash, page_index)] != source_hash:
                problem("FILE_PAGE_CONFLICT", "同一文件页已有不同原图正在排队，请先取消原任务", 409)
    queue = queue_for(db, user.id, body.mode)
    reservation_live = queue.next_upload_session and queue.next_upload_until and queue.next_upload_until > now()
    reserved_for_reader = reservation_live and queue.next_upload_session != body.reading_session_id
    initial_in_flight = active_count(db, user.id, body.mode)
    capacity = limits_for(user)["capacity"]
    available_slots = max(0, capacity - initial_in_flight - int(bool(reserved_for_reader)))
    row = Submission(owner_id=user.id, mode=body.mode, target_language=body.target_language,
        idempotency_key=key, request_hash=request_hash, quota_pages=0)
    db.add(row)
    db.flush()
    counted = set()
    jobs_to_bind = {}
    for ordinal, item in enumerate(body.items):
        if item.byte_size > settings().max_upload_bytes:
            problem("IMAGE_TOO_LARGE", "图片字节数超过平台限制", 413)
        if item.file_hash:
            binding = db.get(FilePage, (user.id, item.file_hash, item.page_index))
            bound_source = db.get(Asset, binding.asset_id) if binding else None
            if available(bound_source) and bound_source.sha256 != item.image_sha256:
                problem("FILE_PAGE_CONFLICT", "同一文件页已绑定不同原图", 409)
        if item.asset_id:
            asset = owned_asset(db, item.asset_id, user.id)
            if asset.sha256 != item.image_sha256:
                problem("IMAGE_HASH_MISMATCH", "原图与提交摘要不一致", 409)
        else:
            asset = find_shared_original(db, user.id, item.image_sha256, byte_size=item.byte_size, mime=item.content_type)
        from .jobs import content_key, find_reusable, find_shared_result
        reusable = None if body.regenerate else find_reusable(db, user, item.image_sha256, body.mode, body.target_language, config)
        if not reusable and not body.regenerate:
            reusable = find_shared_result(db, content_key(user, item.image_sha256, body.mode, body.target_language, config))
        if not reusable and reserved_for_reader and active_count(db, user.id, body.mode) >= limits_for(user)["capacity"] - 1:
            problem("READING_UPLOAD_RESERVED", "下一上传空位已为当前阅读页面预留", 409,
                    available_slots=available_slots, capacity=capacity, in_flight=initial_in_flight)
        try:
            job = create_job(db, user, asset, body.mode, body.target_language, f"{row.id}:{ordinal}", operation="submission",
                force=body.regenerate, config=config, ordinal=ordinal, max_quota_pages=body.max_quota_pages - row.quota_pages,
                expected_kind=body.expected_kind, source_sha256=item.image_sha256, file_hash=item.file_hash, page_index=item.page_index)
        except HTTPException as error:
            if isinstance(error.detail, dict) and error.detail.get("code") == "QUEUE_FULL":
                # The whole manifest rolls back: report capacity before this
                # tentative batch, not its partially reserved intermediate state.
                error.detail.update(available_slots=available_slots, capacity=capacity, in_flight=initial_in_flight)
            raise
        created = job.operation == "submission" and job.idempotency_key == f"{row.id}:{ordinal}"
        if created and not job.cache_hit and job.id not in counted:
            row.quota_pages += job.quota_pages
            counted.add(job.id)
        if row.quota_pages > body.max_quota_pages:
            problem("QUOTA_BOUND_EXCEEDED", "新增翻译超出已确认页数", 409)
        db.add(SubmissionItem(submission_id=row.id, ordinal=ordinal, client_item_id=item.client_item_id,
                              job_id=job.id, descriptor=item.model_dump(), reused=not created or job.cache_hit))
        if not job.input_asset_id:
            create_upload(db, job, {"sha256": item.image_sha256, "byte_size": item.byte_size, "mime": item.content_type})
        else:
            jobs_to_bind[job.id] = job
    # Multiple files/pages can reuse one content job. Bind their complete set
    # once, rather than rescanning its growing manifest for every duplicate.
    for job in jobs_to_bind.values():
        bind_file_page(db, job, submission_id=row.id)
    if counted and reservation_live and queue.next_upload_session == body.reading_session_id:
        queue.next_upload_session = queue.next_upload_until = None
    db.flush()
    result = submission_json(db, row)
    db.commit()
    return result


@router.get("/v1/translation-submissions")
def submissions(offset: int = Query(0, ge=0), limit: int = Query(30, ge=1, le=100),
                user: User = Depends(identity), db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Submission).where(Submission.owner_id == user.id, Submission.archived_at.is_(None)))
    rows = db.scalars(select(Submission).where(Submission.owner_id == user.id, Submission.archived_at.is_(None)).order_by(Submission.created_at.desc(), Submission.id).offset(offset).limit(limit)).all()
    grouped = defaultdict(list)
    if rows:
        source, output, parent = aliased(Asset), aliased(Asset), aliased(Asset)
        at = now()

        def retained(asset):
            return and_(asset.id.is_not(None), asset.owner_id == user.id,
                        asset.deleted_at.is_(None), asset.purged_at.is_(None),
                        or_(asset.expires_at.is_(None), asset.expires_at > at))

        result_valid = and_(retained(source), retained(output), retained(parent))
        projection = select(SubmissionItem.submission_id, SubmissionItem.ordinal, SubmissionItem.reused,
            Job.id, Job.input_asset_id, Job.status, Job.quality_flags, Job.quota_pages, Job.settlement,
            and_(Job.output_asset_id.is_not(None), ~result_valid).label("result_expired"))
        projection = projection.join(Job, Job.id == SubmissionItem.job_id).outerjoin(source, source.id == Job.input_asset_id).outerjoin(output, output.id == Job.output_asset_id).outerjoin(parent, parent.id == output.parent_id)
        for entry in db.execute(projection.where(SubmissionItem.submission_id.in_([r.id for r in rows]), Job.owner_id == user.id).order_by(SubmissionItem.submission_id, SubmissionItem.ordinal)):
            grouped[entry.submission_id].append(entry)
    items = []
    for row in rows:
        entries = grouped[row.id]
        chargeable = {j.id: j for j in entries if not j.reused}.values()
        counts = Counter("expired" if j.result_expired else "partial" if j.status == "succeeded" and "unrecognized_regions" in (j.quality_flags or []) else j.status for j in entries)
        items.append({"id": row.id, "kind": "submission", "mode": row.mode, "target_language": row.target_language,
            "created_at": row.created_at.isoformat() + "Z", "quota_pages": row.quota_pages,
            "status": submission_status(entries), "page_count": len(entries), "counts": dict(counts),
            "job_ids": [j.id for j in entries], "asset_ids": [j.input_asset_id for j in entries if j.input_asset_id],
            "settled": sum(j.quota_pages for j in chargeable if j.settlement == "settled"),
            "reserved": sum(j.quota_pages for j in chargeable if j.settlement == "reserved"),
            "reused": sum(j.reused for j in entries)})
    return {"items": items, "total": total, "next_offset": offset + limit if offset + limit < total else None}


@router.get("/v1/translation-submissions/{submission_id}")
def submission_get(submission_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    return submission_json(db, owned_submission(db, submission_id, user.id))


@router.post("/v1/translation-submissions/{submission_id}/cancel")
def submission_cancel(submission_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    row = owned_submission(db, submission_id, user.id)
    for job in db.scalars(select(Job).where(Job.id.in_(select(SubmissionItem.job_id).where(SubmissionItem.submission_id == row.id))).order_by(Job.id)):
        cancel_job(db, job)
    db.flush()
    result = submission_json(db, row)
    db.commit()
    return result


@router.put("/v1/uploads/{upload_id}/content")
async def upload_content(upload_id: str, request: Request, user: User = Depends(identity), db: Session = Depends(get_db)):
    reservation = owned_upload(db, upload_id, user.id)
    try:
        data = await read_upload_stream(request, reservation.expected_size)
    except HTTPException as error:
        details = error.detail if isinstance(error.detail, dict) else {}
        await run_in_threadpool(fail_upload, db, reservation, details.get("code", "INVALID_UPLOAD"),
                               details.get("message", "上传不完整"), awaiting_only=True)
        db.commit()
        raise
    await run_in_threadpool(receive_upload, db, reservation, user.id, data)
    db.commit()
    if reservation.error_code:
        problem(reservation.error_code, reservation.error_message, 422)
    return upload_json(reservation)


@router.post("/v1/uploads/{upload_id}/complete")
def upload_complete(upload_id: str, user: User = Depends(identity), db: Session = Depends(get_db)):
    lock_scheduler(db)
    reservation = owned_upload(db, upload_id, user.id)
    job = db.get(Job, reservation.job_id)
    if reservation.status in {"awaiting_upload", "uploaded"} and reservation.expires_at <= now() and job.status == "awaiting_upload":
        fail_upload(db, reservation, "UPLOAD_EXPIRED", "上传会话已过期，请重新提交", status="expired")
        db.commit()
        problem("UPLOAD_EXPIRED", "上传会话已过期，请重新提交", 410)
    if reservation.status == "uploaded" and job.status == "awaiting_upload":
        reservation.status = "validating"
        job.status, job.phase = "validating_upload", "validating_upload"
        db.add(JobStage(job_id=job.id, name="validate_upload", status="ready"))
        touch_job(db, job)
    elif reservation.status == "awaiting_upload":
        problem("UPLOAD_INCOMPLETE", "原图尚未上传完成", 409)
    db.commit()
    return job_json(db, job)
