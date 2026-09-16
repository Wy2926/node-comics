"""Database-owned translation suppliers. No environment seeding or legacy fallback."""
from contextlib import contextmanager
import logging
from fastapi import APIRouter, Depends
from pydantic import Field, SecretStr, field_validator, model_validator
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from .adapters.text import TextError
from .auth import admin
from .db import get_db, session_factory
from .errors import problem
from .models import User, now, uid
from .request_models import RequestBody
from .scheduler import lock_scheduler
from .translation_channels import CHANNELS
from .translation_models import TranslationProvider, TranslationProviderRevision

router = APIRouter(prefix='/v1/admin/translation-providers', tags=['translation-providers'])


class ProviderWrite(RequestBody):
    name: str = Field(min_length=1, max_length=100)
    channel: str = Field(min_length=1, max_length=40)
    enabled: bool = Field(default=True, strict=True)
    config: dict
    api_key: SecretStr | None = Field(default=None, exclude=True)

    @field_validator('name')
    @classmethod
    def valid_name(cls, value):
        if not value.strip():
            raise ValueError('Name is required')
        return value.strip()

    @field_validator('api_key')
    @classmethod
    def valid_key(cls, value):
        if value is not None:
            key = value.get_secret_value()
            if not 1 <= len(key) <= 4096 or not key.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in key):
                raise ValueError('Invalid credential')
        return value

    @model_validator(mode='after')
    def validate_channel(self):
        channel = CHANNELS.get(self.channel)
        if channel is None:
            raise ValueError('Unsupported translation channel')
        self.config = channel.config_type.model_validate(self.config).model_dump()
        return self


class ProviderToggle(RequestBody):
    enabled: bool = Field(strict=True)


def provider_json(db, provider):
    revision = db.get(TranslationProviderRevision, provider.revision_id)
    return {'id': provider.id, 'name': provider.name, 'channel': provider.channel,
            'enabled': provider.enabled, 'is_default': provider.is_default,
            'revision_id': provider.revision_id, 'credential_configured': revision is not None,
            'config': revision.config if revision else {},
            'created_at': provider.created_at.isoformat() + 'Z',
            'updated_at': provider.updated_at.isoformat() + 'Z'}


def selected_provider(db, provider_id=None):
    query = select(TranslationProvider).where(TranslationProvider.enabled.is_(True))
    query = query.where(TranslationProvider.id == provider_id) if provider_id else query.where(TranslationProvider.is_default.is_(True))
    return db.scalar(query)


def text_profile(db, provider_id=None):
    provider = selected_provider(db, provider_id)
    revision = db.get(TranslationProviderRevision, provider.revision_id) if provider else None
    if not revision or revision.channel not in CHANNELS:
        problem('TRANSLATION_PROVIDER_UNAVAILABLE', '请在管理后台创建并启用默认翻译供应商', 503)
    return {'provider_id': provider.id, 'revision_id': revision.id, 'channel': revision.channel, **revision.config}


def require_enabled(db, profile):
    provider = db.get(TranslationProvider, profile['provider_id'])
    if not provider:
        raise TextError('TEXT_PROVIDER_UNAVAILABLE', '翻译供应商不存在')
    if not provider.enabled:
        raise TextError('TEXT_PROVIDER_DISABLED', '翻译供应商已停用，等待重新启用', usage={'input_tokens': 0, 'output_tokens': 0})
    return provider


def resolve_credentials(profile):
    with session_factory()() as db:
        require_enabled(db, profile)
        revision = db.get(TranslationProviderRevision, profile['revision_id'])
        if (not revision or revision.provider_id != profile['provider_id'] or
                profile != {'provider_id': revision.provider_id, 'revision_id': revision.id,
                            'channel': revision.channel, **revision.config}):
            raise TextError('TEXT_PROVIDER_REVISION_INVALID', '任务的翻译供应商版本无效')
        return revision.api_key


def write_provider(db, body, provider=None):
    """Called under the scheduler mutex; never accesses the upstream service."""
    previous = db.get(TranslationProviderRevision, provider.revision_id) if provider else None
    if body.api_key is None and previous is None:
        problem('TRANSLATION_KEY_REQUIRED', '创建翻译供应商时必须填写 API Key', 422)
    key = body.api_key.get_secret_value() if body.api_key is not None else previous.api_key
    if provider is None:
        first = db.scalar(select(TranslationProvider.id).limit(1)) is None
        provider = TranslationProvider(id=uid(), name=body.name, channel=body.channel,
                                       enabled=body.enabled, is_default=first)
        db.add(provider)
        db.flush()
    elif body.channel != provider.channel:
        problem('TRANSLATION_CHANNEL_IMMUTABLE', '更换渠道请新建供应商', 422)
    if previous is None or previous.config != body.config or previous.api_key != key:
        revision = TranslationProviderRevision(id=uid(), provider_id=provider.id, channel=body.channel,
                                                config=body.config, api_key=key)
        db.add(revision)
        db.flush()
        provider.revision_id = revision.id
    provider.name, provider.enabled = body.name, body.enabled
    provider.requests_per_minute = body.config['requests_per_minute']
    provider.updated_at = now()
    db.flush()
    return provider


def get_provider(db, provider_id):
    provider = db.get(TranslationProvider, provider_id)
    if provider is None:
        problem('NOT_FOUND', '翻译供应商不存在', 404)
    return provider


@contextmanager
def provider_transaction(db):
    try:
        lock_scheduler(db)
        yield
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        # Even a driver's failure DETAIL can contain a complete credential row.
        # Never let its traceback or parameters reach Uvicorn's error logger.
        logging.getLogger(__name__).warning('Translation provider save failed: %s', type(error).__name__)
        problem('TRANSLATION_PROVIDER_SAVE_FAILED', '供应商保存失败，请刷新列表核对后重试', 503)


@router.get('')
def list_providers(user: User = Depends(admin), db: Session = Depends(get_db)):
    return {'items': [provider_json(db, row) for row in db.scalars(select(TranslationProvider).order_by(TranslationProvider.created_at, TranslationProvider.id))],
            'channels': [{'id': key, 'label': value.label, 'protocols': list(value.protocols)} for key, value in CHANNELS.items()]}


@router.post('', status_code=201)
def create_provider(body: ProviderWrite, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        provider = write_provider(db, body)
    return provider_json(db, provider)


@router.put('/{provider_id}')
def update_provider(provider_id: str, body: ProviderWrite, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        provider = write_provider(db, body, get_provider(db, provider_id))
    return provider_json(db, provider)


@router.patch('/{provider_id}')
def toggle_provider(provider_id: str, body: ProviderToggle, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        provider = get_provider(db, provider_id)
        provider.enabled, provider.updated_at = body.enabled, now()
    return provider_json(db, provider)


@router.post('/{provider_id}/default')
def default_provider(provider_id: str, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        provider = get_provider(db, provider_id)
        if not provider.enabled:
            problem('TRANSLATION_PROVIDER_DISABLED', '请先启用此供应商', 409)
        db.execute(update(TranslationProvider).where(TranslationProvider.is_default.is_(True)).values(is_default=False, updated_at=now()))
        provider.is_default, provider.updated_at = True, now()
    return provider_json(db, provider)
