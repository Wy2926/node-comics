"""Account title-query limits, independent of model requests and durable caches."""
from fastapi import HTTPException
from .models import uid
from .redis_state import window

WINDOW_SECONDS = 60
REQUEST_LIMIT = 30


def title_budget(db, owner_id):
    return window('title', owner_id, REQUEST_LIMIT)


def admit_title(owner_id):
    budget = window('title', owner_id, REQUEST_LIMIT, member=uid())
    retry = budget['retry_after_seconds']
    if retry:
        raise HTTPException(429, detail={'code': 'COMIC_TITLE_RATE_LIMITED',
            'message': '漫画名翻译每分钟最多调用 30 次', 'retry_after_seconds': retry},
            headers={'Retry-After': str(retry)})
