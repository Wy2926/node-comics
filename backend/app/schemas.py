"""Public response contracts exported through OpenAPI for extension type generation."""
from pydantic import BaseModel
from typing import Literal


class ErrorInfo(BaseModel):
    code: str
    message: str


class QuotaBucketResponse(BaseModel):
    id: str
    kind: str
    source: str
    mode: str
    granted: int
    used: int
    reserved: int
    available: int
    starts_at: str
    expires_at: str
    grants_access: bool
    note: str


class PeriodResponse(BaseModel):
    id: str
    kind: str
    granted: int
    used: int
    reserved: int
    available: int
    starts_at: str
    resets_at: str | None
    next_expiry_at: str
    buckets: list[QuotaBucketResponse]


class ModeEntitlement(BaseModel):
    allowed: bool
    unlimited: bool
    quota_kind: str
    consent_version: str
    quota: PeriodResponse | None


class EntitlementsResponse(BaseModel):
    plan: str
    plus_started_at: str | None
    plus_expires_at: str | None
    timezone: str
    image_rate_limit: dict
    scheduler_weight: float
    modes: dict[str, ModeEntitlement]
    generated_at: str
    pending_previous_period_pages: int


class UserResponse(BaseModel):
    id: str
    name: str
    role: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    expires_in: int
    user: UserResponse


class AssetResponse(BaseModel):
    id: str
    width: int
    height: int
    mime: str
    sha256: str
    byte_size: int
    kind: str
    expires_at: str | None


class AccessResponse(BaseModel):
    url: str
    expires_at: str | None
    authorization_required: bool


class JobResponse(BaseModel):
    id: str
    input_asset_id: str | None
    image_sha256: str
    file_hash: str | None = None
    page_index: int | None = None
    change_sequence: int = 0
    priority: str = "preload"
    requested_asset_id: str | None = None
    output_asset_id: str | None
    result_available: bool
    result_expired: bool
    mode: str
    target_language: str
    status: str
    phase: str
    quota_pages: int
    quota_kind: str
    quota_period_id: str | None
    settlement: str
    version: int
    cache_hit: bool
    reused: bool = False
    cancel_requested: bool
    error: ErrorInfo | None
    quality_flags: list[str]
    created_at: str
    completed_at: str | None


class JobsResponse(BaseModel):
    items: list[JobResponse]


class JobPageResponse(JobsResponse):
    total: int
    next_offset: int | None


class UsageEntry(BaseModel):
    id: str
    job_id: str | None
    kind: str
    period_id: str | None
    quota_kind: str | None
    pages: int
    note: str
    created_at: str


class UsageResponse(BaseModel):
    entitlements: EntitlementsResponse
    items: list[UsageEntry]
    total: int
    next_offset: int | None


class ModeCapability(BaseModel):
    id: str
    label: str
    enabled: bool
    languages: list[str]


class LanguageCapability(BaseModel):
    id: str
    label: str


class CapabilitiesResponse(BaseModel):
    modes: list[ModeCapability]
    languages: list[LanguageCapability]
    limits: dict[str, int]
    entitlements: EntitlementsResponse | None
    retention_days: int
    unknown_release_seconds: int


class ImageRateLimit(BaseModel):
    window_seconds: Literal[60]
    limit: int
    remaining: int
    retry_after_seconds: int


class UploadPlanResponse(BaseModel):
    id: str
    job_id: str
    status: str
    asset_id: str | None
    url: str
    method: Literal['PUT']
    headers: dict[str, str]
    authorization_required: bool
    expires_at: str
    error: ErrorInfo | None


class OperationResponse(BaseModel):
    operation_key: str
    page_key: str | None = None
    disposition: Literal['ready', 'pending', 'accepted', 'deferred', 'blocked', 'not_found']
    job: JobResponse | None = None
    upload: UploadPlanResponse | None = None
    code: str | None = None
    message: str | None = None
    scope: str | None = None
    retry_after_seconds: int | None = None
    created_at: str | None = None


class PriorityResponse(BaseModel):
    owned: bool
    epoch: int
    expires_at: str | None


class PlanSnapshotResponse(BaseModel):
    policy_revision: str
    server_time: str
    image_rate_limit: ImageRateLimit
    entitlements: EntitlementsResponse


class TranslationPlanResponse(PlanSnapshotResponse):
    session_id: str | None
    applied_sequence: int | None
    priority: dict[str, PriorityResponse]
    items: list[OperationResponse]
    error: dict | None = None


class OperationResolutionResponse(BaseModel):
    items: list[OperationResponse]
    policy_revision: str


class OperationPageResponse(BaseModel):
    items: list[OperationResponse]
    total: int
    next_offset: int | None


class ReadingLeaseResponse(BaseModel):
    session_id: str
    priority: dict[str, PriorityResponse]
    policy_revision: str


class TranslationChangesResponse(PlanSnapshotResponse):
    items: list[JobResponse]
    deleted_job_ids: list[str]
    cursor: str
    has_more: bool
