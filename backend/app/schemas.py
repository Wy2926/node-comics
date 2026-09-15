"""Public response contracts exported through OpenAPI for extension type generation."""
from pydantic import BaseModel


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
    queue_capacity: int
    realtime_slots: int
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
    submission_id: str | None = None
    ordinal: int
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
