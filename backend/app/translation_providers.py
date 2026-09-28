"""Database-owned translation suppliers. No environment seeding or legacy fallback."""
from contextlib import contextmanager
import logging
from fastapi import APIRouter, Depends, Query
from pydantic import Field, SecretStr, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, undefer
from .adapters.llm import TextError
from .adapters.text import TextPolicy
from .auth import admin
from .admin_audit import record_audit, sanitize
from .db import get_db, session_factory
from .errors import problem
from .models import User, now, uid
from .request_models import RequestBody
from .scheduler import lock_scheduler
from .translation_channels import CHANNELS
from .translation_models import TranslationProvider, TranslationProviderRevision

router = APIRouter(prefix='/v1/admin/translation-providers', tags=['translation-providers'])
PURPOSE_WEIGHTS = {'text': TranslationProvider.text_weight, 'comic_title': TranslationProvider.title_weight}


class ProviderWrite(RequestBody):
    name: str = Field(min_length=1, max_length=100)
    channel: str = Field(min_length=1, max_length=40)
    enabled: bool = Field(default=True, strict=True)
    text_weight: int = Field(default=1, ge=0, le=10000, strict=True)
    title_weight: int = Field(default=1, ge=0, le=10000, strict=True)
    requests_per_minute: int = Field(default=60, ge=1, le=10000, strict=True)
    config: dict
    api_key: SecretStr | None = Field(default=None, exclude=True)

    @model_validator(mode='before')
    @classmethod
    def separate_legacy_limit(cls, value):
        # Accept an old admin form without storing its upstream limit in a revision.
        if isinstance(value, dict) and isinstance(value.get('config'), dict) and 'requests_per_minute' in value['config']:
            config = dict(value['config'])
            limit = config.pop('requests_per_minute')
            return {**value, 'requests_per_minute': value.get('requests_per_minute', limit), 'config': config}
        return value

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
        connection = {key: value for key, value in self.config.items() if key not in TextPolicy.model_fields}
        policy = {key: value for key, value in self.config.items() if key in TextPolicy.model_fields}
        self.config = {**channel.config_type.model_validate(connection).model_dump(),
                       **TextPolicy.model_validate(policy).model_dump()}
        return self


class ProviderToggle(RequestBody):
    enabled: bool = Field(strict=True)


def provider_json(db, provider):
    revision = db.get(TranslationProviderRevision, provider.revision_id)
    return {'id': provider.id, 'name': provider.name, 'channel': provider.channel,
            'enabled': provider.enabled, 'text_weight': provider.text_weight,
            'title_weight': provider.title_weight,
            'requests_per_minute': provider.requests_per_minute,
            'revision_id': provider.revision_id, 'credential_configured': revision is not None,
            'config': {key: value for key, value in revision.config.items() if key != 'requests_per_minute'} if revision else {},
            'created_at': provider.created_at.isoformat() + 'Z',
            'updated_at': provider.updated_at.isoformat() + 'Z'}


def _provider_query(provider_id=None, *, purpose='text'):
    weight = PURPOSE_WEIGHTS[purpose]
    query = select(TranslationProvider.id, weight.label('weight'),
        TranslationProviderRevision.id.label('revision_id'), TranslationProviderRevision.channel,
        TranslationProviderRevision.config).join(TranslationProviderRevision,
            TranslationProviderRevision.id == TranslationProvider.revision_id).where(
        TranslationProvider.enabled.is_(True), TranslationProviderRevision.channel.in_(CHANNELS))
    return query.where(TranslationProvider.id == provider_id) if provider_id else query.where(weight > 0)


def has_provider(db, *, purpose='text'):
    return db.scalar(_provider_query(purpose=purpose).limit(1)) is not None


def provider_resolver(db, provider_id=None, *, purpose='text'):
    """Freeze this request's eligible weights and secret-free revisions in one read."""
    from .translation_routing import choose_provider
    candidates = db.execute(_provider_query(provider_id, purpose=purpose)).all()
    if not candidates:
        label = '漫画名' if purpose == 'comic_title' else '正文'
        problem('TRANSLATION_PROVIDER_UNAVAILABLE', f'请在管理后台启用至少一个{label}权重大于 0 的供应商', 503)
    weights = {row.id: 1 if provider_id else row.weight for row in candidates}
    profiles = {row.id: {'provider_id': row.id, 'revision_id': row.revision_id,
                        'channel': row.channel, **row.config} for row in candidates}
    return lambda routing_key='': profiles[choose_provider(weights, routing_key)]


def provider_profile(db, provider_id=None, *, purpose='text', routing_key=''):
    return provider_resolver(db, provider_id, purpose=purpose)(routing_key)


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
        revision = db.get(TranslationProviderRevision, profile['revision_id'],
                          options=[undefer(TranslationProviderRevision.api_key)])
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
        provider = TranslationProvider(id=uid(), name=body.name, channel=body.channel,
                                       enabled=body.enabled, text_weight=body.text_weight)
        db.add(provider)
        db.flush()
    elif body.channel != provider.channel:
        problem('TRANSLATION_CHANNEL_IMMUTABLE', '更换渠道请新建供应商', 422)
    previous_config = {key: value for key, value in previous.config.items() if key != 'requests_per_minute'} if previous else None
    if previous is None or previous_config != body.config or previous.api_key != key:
        revision = TranslationProviderRevision(id=uid(), provider_id=provider.id, channel=body.channel,
                                                config=body.config, api_key=key)
        db.add(revision)
        db.flush()
        provider.revision_id = revision.id
    provider.name, provider.enabled = body.name, body.enabled
    provider.text_weight = body.text_weight
    provider.title_weight = body.title_weight
    provider.requests_per_minute = body.requests_per_minute
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
        record_audit(db, user.id, 'text_provider.create', 'translation_provider', provider.id,
                     after=provider_json(db, provider), details={'key_changed': True})
    return provider_json(db, provider)


@router.put('/{provider_id}')
def update_provider(provider_id: str, body: ProviderWrite, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        previous = get_provider(db, provider_id)
        before = provider_json(db, previous)
        provider = write_provider(db, body, previous)
        record_audit(db, user.id, 'text_provider.update', 'translation_provider', provider.id,
                     before=before, after=provider_json(db, provider), details={'key_changed': body.api_key is not None})
    return provider_json(db, provider)


@router.patch('/{provider_id}')
def toggle_provider(provider_id: str, body: ProviderToggle, user: User = Depends(admin), db: Session = Depends(get_db)):
    with provider_transaction(db):
        provider = get_provider(db, provider_id)
        before = {'enabled': provider.enabled}
        provider.enabled, provider.updated_at = body.enabled, now()
        record_audit(db, user.id, 'text_provider.toggle', 'translation_provider', provider.id,
                     before=before, after={'enabled': provider.enabled})
    return provider_json(db, provider)


@router.get('/{provider_id}/revisions')
def revisions(provider_id: str, offset: int = Query(0, ge=0), limit: int = Query(25, ge=1, le=100),
              user: User = Depends(admin), db: Session = Depends(get_db)):
    provider = get_provider(db, provider_id)
    query = select(TranslationProviderRevision.id, TranslationProviderRevision.channel,
        TranslationProviderRevision.config, TranslationProviderRevision.created_at).where(
        TranslationProviderRevision.provider_id == provider_id)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(query.order_by(TranslationProviderRevision.created_at.desc(), TranslationProviderRevision.id.desc())
                      .offset(offset).limit(limit))
    return {'items': [{'id': row.id, 'channel': row.channel, 'config': sanitize(row.config),
            'current': row.id == provider.revision_id, 'created_at': row.created_at} for row in rows],
            'total': total, 'next_offset': offset + limit if offset + limit < total else None}
