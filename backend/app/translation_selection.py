"""Public model choices share the same locked entitlement decisions as admission."""
from .classic_config import profile_snapshot
from .config import settings
from .entitlements import admission_policy, free_model_policy, membership_benefits, membership_choices, UNLIMITED
from .errors import problem
from .models import now
from .providers import digest
from .translation_models import TranslationProvider
from .translation_providers import _provider_query


def policy_resolver(db, user, at=None):
    """Reuse membership reads and bounded bucket lookups per distinct service scope."""
    at = at or now()
    guest = user is None or user.kind == 'guest'
    choices = [] if guest else membership_choices(db, user, at)
    benefits = None if guest else membership_benefits(db, user, at, choices=choices)
    policies = {}

    def resolve(plans):
        if guest:
            allowed = plans is None or 'guest' in plans
            return (admission_policy(db, user, at=at) if user and allowed else None,
                    None if allowed else 'not_allowed')
        free = plans is None or 'free' in plans
        key = None if free else tuple(sorted(plans))
        if key not in policies:
            policy = admission_policy(db, user, at=at, benefits=benefits,
                                      service_plans=None if free else plans, choices=choices)
            if free:
                policy = free_model_policy(db, user, policy, at)
            reason = ('not_allowed' if not free and policy.service_plan not in plans else
                      'quota_exhausted' if policy.kind != UNLIMITED and policy.period is None else None)
            policies[key] = policy, reason
        return policies[key]
    return resolve


def model_catalog(db, user, default_plan):
    # Public reads neither load upstream configurations/credentials nor probe models.
    rows = db.execute(_provider_query().with_only_columns(
        TranslationProvider.id, TranslationProvider.name, TranslationProvider.text_plan_ids)
        .order_by(TranslationProvider.created_at, TranslationProvider.id)).all()
    resolve = policy_resolver(db, user) if rows else None
    models = [{'id': row.id, 'name': row.name,
             'requires_paid': row.text_plan_ids is not None and 'free' not in row.text_plan_ids,
             'available': reason is None, 'unavailable_reason': reason}
            for row in rows
            for reason in [('unavailable' if not settings().classic_enabled else resolve(row.text_plan_ids)[1])]]
    enabled = settings().classic_enabled and (any(item['available'] for item in models) or
        any(row.text_plan_ids is None or default_plan in row.text_plan_ids for row in rows))
    return models, enabled


def select_model(db, user, model_id, at):
    # Unlike the private provider_id path this always requires positive body weight.
    row = db.execute(_provider_query().where(TranslationProvider.id == model_id)).first()
    if row is None:
        if db.get(TranslationProvider, model_id) is None:
            problem('TRANSLATION_MODEL_INVALID', '未知翻译模型，请刷新模型列表', 422)
        problem('TRANSLATION_MODEL_UNAVAILABLE', '所选模型暂不可用，请重新选择', 503)
    policy, reason = policy_resolver(db, user, at)(row.text_plan_ids)
    config = profile_snapshot({'provider_id': row.id, 'revision_id': row.revision_id,
                               'channel': row.channel, **row.config})
    # Delay access rejection until after account-owned result/in-flight reuse.
    return {**config, 'version': digest(config)}, policy, reason
