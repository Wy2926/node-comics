"""Translation identities and server-selected text model snapshots."""
import hashlib
import json
from sqlalchemy.orm import Session
from .errors import problem
from .languages import LANGUAGES


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def configuration_resolver(db: Session, mode: str, language: str, provider_id=None, *, plan_id='free'):
    """Read current suppliers once, then resolve pages against that snapshot."""
    if mode != 'classic':
        problem('MODE_UNSUPPORTED', '不支持此翻译方式', 422)
    if language not in LANGUAGES:
        problem('LANGUAGE_UNSUPPORTED', '此目标语言尚未开放', 422)
    from .classic_config import snapshot_resolver
    resolve = snapshot_resolver(db, provider_id, plan_id=plan_id)

    def configured(source_sha256=''):
        config = resolve(digest([source_sha256, language]))
        return {**config, 'version': digest(config)}
    return configured


def configuration(db: Session, mode: str, language: str, provider_id=None, *, source_sha256='', plan_id='free'):
    return configuration_resolver(db, mode, language, provider_id, plan_id=plan_id)(source_sha256)
