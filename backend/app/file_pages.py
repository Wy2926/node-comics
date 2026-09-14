"""Private source-file identities. Page indices belong to the file, not reader order."""
import hashlib
from typing import Literal
from fastapi import HTTPException

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, select, tuple_
from sqlalchemy.orm import Mapped, mapped_column

from .assets import asset_json, available, create_asset
from .db import Base
from .errors import problem
from .jobs import job_json, locked_user
from .models import Asset, Job
from .providers import configuration, digest
from .schemas import AssetResponse, JobResponse


class FilePage(Base):
    __tablename__ = "file_pages"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    file_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    page_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True)
    __table_args__ = (CheckConstraint("page_index >= 0"),)


class FilePageIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    file_hash: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    page_index: int = Field(ge=0, le=1_000_000, strict=True)

    @field_validator("file_hash")
    @classmethod
    def lowercase_hash(cls, value):
        return value.lower()


class FilePageMatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pages: list[FilePageIdentity] = Field(min_length=1, max_length=100)
    mode: Literal["classic", "redraw"]
    target_language: str
    include_display: bool = False


class FilePageMatch(FilePageIdentity):
    asset: AssetResponse | None
    jobs: list[JobResponse]
    display_jobs: list[JobResponse] = Field(default_factory=list)


class FilePageMatches(BaseModel):
    items: list[FilePageMatch]


def upload_file_page(db, owner_id: str, data: bytes, source: FilePageIdentity):
    # Serialize two devices binding the same identity; no duplicate assets or lost mapping.
    locked_user(db, owner_id)
    identity = (owner_id, source.file_hash, source.page_index)
    mapping = db.get(FilePage, identity)
    previous = db.get(Asset, mapping.asset_id) if mapping else None
    if previous:
        if previous.sha256 != hashlib.sha256(data).hexdigest():
            problem("FILE_PAGE_CONFLICT", "同一文件与页索引对应的图片内容不一致，请重新导入文件", 409)
        if available(previous):
            return previous
    asset = create_asset(db, owner_id, data)
    if mapping:
        mapping.asset_id = asset.id
    else:
        db.add(FilePage(owner_id=owner_id, file_hash=source.file_hash,
                        page_index=source.page_index, asset_id=asset.id))
    db.flush()
    return asset


def match_file_pages(db, owner_id: str, body: FilePageMatchRequest):
    try:
        config = configuration(db, body.mode, body.target_language)
    except HTTPException as error:
        if not body.include_display or error.detail.get("code") not in {"PROVIDER_CAPABILITY_UNSUPPORTED", "CLASSIC_NOT_CONFIGURED", "CLASSIC_CONFIG_INVALID"}:
            raise
        config = None  # Reading existing images does not require an enabled supplier.
    identities = {(page.file_hash, page.page_index) for page in body.pages}
    mappings = db.scalars(select(FilePage).where(
        FilePage.owner_id == owner_id,
        tuple_(FilePage.file_hash, FilePage.page_index).in_(identities),
    )).all()
    sources = {}
    display_sources = {}
    cache_keys = {}
    for mapping in mappings:
        asset = db.get(Asset, mapping.asset_id)
        if not asset or asset.owner_id != owner_id or asset.kind != "original":
            continue
        identity = (mapping.file_hash, mapping.page_index)
        display_sources[identity] = asset
        if not available(asset):
            continue
        sources[identity] = asset
        if config:
            cache_keys[identity] = digest({"owner": owner_id, "hash": asset.sha256,
                "mode": body.mode, "language": body.target_language, "config_version": config["version"]})
    jobs_by_key = {}
    if cache_keys:
        candidates = db.scalars(select(Job).where(
            Job.owner_id == owner_id, Job.cache_key.in_(set(cache_keys.values())),
            Job.mode == body.mode, Job.target_language == body.target_language,
            Job.status.in_(["queued", "running", "outcome_unknown", "succeeded", "no_text"]),
            Job.cancel_requested.is_(False), Job.discard_output.is_(False),
        ).order_by(Job.version, Job.created_at, Job.id)).all()
        for job in candidates:
            source = db.get(Asset, job.input_asset_id)
            if not available(source) or source.owner_id != owner_id:
                continue
            if job.status == "succeeded":
                output = db.get(Asset, job.output_asset_id) if job.output_asset_id else None
                if not available(output) or output.owner_id != owner_id:
                    continue
                if output.parent_id and not available(db.get(Asset, output.parent_id)):
                    continue
            jobs_by_key.setdefault(job.cache_key, []).append(job_json(db, job))
    display_by_hash = {}
    if body.include_display and display_sources:
        # A display result is independent of the currently configured provider.
        # Include the latest delivered tombstone, so a newly signed-in device
        # cannot silently fall back to an older effect after deletion/expiry.
        candidates = db.execute(select(Job, Asset.sha256).join(Asset, Asset.id == Job.input_asset_id).where(
            Job.owner_id == owner_id, Asset.owner_id == owner_id,
            Asset.sha256.in_({asset.sha256 for asset in display_sources.values()}),
            Job.mode == body.mode, Job.target_language == body.target_language,
        ).order_by(Job.created_at.desc(), Job.version.desc(), Job.id.desc()))
        for job, content_hash in candidates:
            bucket = display_by_hash.setdefault(content_hash, {})
            bucket.setdefault("latest", job)
            if job.status in ("queued", "running", "outcome_unknown"):
                bucket.setdefault("pending", job)
            if job.status == "succeeded":
                bucket.setdefault("result", job)
    # Always return request order, including misses; this is lookup only, with no billing.
    return {"items": [{"file_hash": page.file_hash, "page_index": page.page_index,
        "asset": asset_json(sources[key]) if key in sources else None,
        "jobs": jobs_by_key.get(cache_keys.get(key), []),
        **({"display_jobs": [job_json(db, job) for job in {job.id: job for job in display_by_hash.get(display_sources[key].sha256, {}).values()}.values()] if key in display_sources else []} if body.include_display else {})}
        for page in body.pages for key in [(page.file_hash, page.page_index)]]}
