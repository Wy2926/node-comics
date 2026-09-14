"""Public response contracts exported through OpenAPI for extension type generation."""
from pydantic import BaseModel, Field


class ErrorInfo(BaseModel):
    code: str
    message: str


class QuotaResponse(BaseModel):
    balance: int
    reserved: int
    available: int


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
    expires_at: str


class AccessResponse(BaseModel):
    url: str
    expires_at: str
    authorization_required: bool


class JobResponse(BaseModel):
    id: str
    input_asset_id: str
    requested_asset_id: str | None = None
    output_asset_id: str | None
    result_available: bool
    result_expired: bool
    mode: str
    target_language: str
    status: str
    phase: str
    cost: int
    settlement: str
    version: int
    cache_hit: bool
    reused: bool = False
    batch_id: str | None
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


class QuoteResponse(BaseModel):
    id: str
    total_cost: int
    unit_cost: int
    page_count: int
    expires_at: str
    config_version: str
    mode: str
    target_language: str


class BatchCreatedResponse(BaseModel):
    id: str
    status: str
    jobs: list[JobResponse]
    total_cost: int


class BatchResponse(BaseModel):
    id: str
    status: str
    items: list[JobResponse]
    total: int
    next_offset: int | None
    total_cost: int


class UsageEntry(BaseModel):
    id: str
    job_id: str | None
    kind: str
    amount: int
    note: str
    created_at: str


class UsageResponse(QuotaResponse):
    items: list[UsageEntry]
    total: int
    next_offset: int | None


class ModeCapability(BaseModel):
    id: str
    label: str
    enabled: bool
    unit_cost: int
    languages: list[str]


class LanguageCapability(BaseModel):
    id: str
    label: str


class CapabilitiesResponse(BaseModel):
    modes: list[ModeCapability]
    languages: list[LanguageCapability]
    limits: dict[str, int]
    quota: QuotaResponse | None
    retention_days: int
    unknown_release_seconds: int
    pricing_version: str
    pricing_note: str
