"""OpenAI text channel. One request, no SDK retries or configuration lookups."""
import json
import time
from email.utils import parsedate_to_datetime
from typing import Literal
from urllib.parse import urlsplit
import httpx
from pydantic import Field, field_validator
from ..errors import ProcessingError
from .transport import read_bounded
from .transport import CheckedTransport
from .llm import LLMConfig, Message, TextError, TextResponse

MAX_RESPONSE_BYTES = 1024 * 1024


class OpenAITextConfig(LLMConfig):
    base_url: str = Field(default='https://api.openai.com/v1', max_length=1000)
    protocol: Literal['chat_completions', 'responses'] = 'chat_completions'
    reasoning_effort: Literal['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'provider_default'] = 'none'
    user_agent: str = Field(default='NodeComics/0.1', min_length=1, max_length=200)

    @field_validator('base_url')
    @classmethod
    def valid_url(cls, value):
        url = urlsplit(value)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment
                or not value.isascii() or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
            raise ValueError('Requires an HTTPS base URL without credentials, query or fragment')
        return value.rstrip('/')

    @field_validator('user_agent')
    @classmethod
    def valid_header(cls, value):
        if not value.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Requires printable ASCII')
        return value


def call_messages(messages: list[Message], profile: dict, api_key: str, *,
                  json_schema: dict | None = None) -> TextResponse:
    chat = profile["protocol"] == "chat_completions"
    payload = {"model": profile["model"], "stream": False, "store": False}
    if chat:
        payload.update(messages=messages, max_completion_tokens=profile["max_output_tokens"])
    else:
        payload.update(input=messages, max_output_tokens=profile["max_output_tokens"])
    if json_schema is not None:
        if chat:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': json_schema}
        else:
            payload['text'] = {'format': {'type': 'json_schema', **json_schema}}
        if urlsplit(profile['base_url']).hostname == 'openrouter.ai':
            payload['provider'] = {'require_parameters': True}
    # Previously saved revisions omit this setting; keep their original request
    # behavior until the administrator saves a new immutable revision.
    effort = profile.get('reasoning_effort', 'provider_default')
    if effort != 'provider_default':
        if chat:
            payload['reasoning_effort'] = effort
        else:
            payload['reasoning'] = {'effort': effort}
    endpoint = profile["base_url"] + ("/chat/completions" if chat else "/responses")
    headers = {"Authorization": "Bearer " + api_key, "User-Agent": profile["user_agent"]}
    try:
        with httpx.Client(transport=CheckedTransport(), trust_env=False, follow_redirects=False,
                          timeout=profile["timeout_seconds"]) as client:
            with client.stream("POST", endpoint, json=payload, headers=headers) as response:
                request_id = response.headers.get("x-request-id", "")[:200] or None
                if response.status_code != 200:
                    retryable = response.status_code in (408, 429, 500, 502, 503, 504)
                    code = ('TEXT_RATE_LIMITED' if response.status_code == 429 else
                            'TEXT_AUTH_FAILED' if response.status_code in (401, 403) else 'TEXT_PROVIDER_REJECTED')
                    raise TextError(code, "文本服务拒绝请求，请检查模型、接口协议、余额与密钥",
                                    retryable=retryable, retry_after=retry_delay(response.headers.get("retry-after")), request_id=request_id)
                raw = read_bounded(response, MAX_RESPONSE_BYTES, time.monotonic() + profile["timeout_seconds"])
        data = json.loads(raw)
        usage = safe_usage(data.get("usage"))
        request_id = request_id or (data.get("id", "")[:200] if isinstance(data.get("id"), str) else None)
        try:
            if chat:
                choice = data["choices"][0]
                if choice['message'].get('refusal') or choice.get('finish_reason') == 'content_filter':
                    raise TextError('TEXT_REFUSED', '文本服务拒绝生成内容', usage=usage, request_id=request_id)
                content = choice["message"]["content"]
                complete = choice.get("finish_reason") == "stop"
            else:
                parts = [part for item in data.get('output', []) if item.get('type') == 'message'
                         for part in item.get('content', [])]
                if any(part.get('type') == 'refusal' for part in parts):
                    raise TextError('TEXT_REFUSED', '文本服务拒绝生成内容', usage=usage, request_id=request_id)
                content = ''.join(part['text'] for part in parts if part.get('type') == 'output_text')
                complete = data.get("status") == "completed"
            if not complete or not isinstance(content, str):
                raise ValueError()
        except (ValueError, KeyError, IndexError, TypeError):
            raise TextError("TEXT_INCOMPLETE", "文本响应被截断或没有完整内容", retryable=True, usage=usage, request_id=request_id) from None
        return TextResponse(content, usage, request_id)
    except TextError:
        raise
    except (httpx.HTTPError, OSError):
        raise TextError("TEXT_TRANSPORT_FAILED", "文本请求超时或连接中断", retryable=True) from None
    except (ValueError, TypeError, AttributeError, ProcessingError):
        raise TextError("TEXT_INVALID_RESPONSE", "文本服务响应无效", retryable=True) from None


def safe_usage(data):
    if not isinstance(data, dict):
        return None
    inp = data.get("prompt_tokens", data.get("input_tokens"))
    out = data.get("completion_tokens", data.get("output_tokens"))
    if type(inp) is not int or type(out) is not int or not (0 <= inp <= 10_000_000 and 0 <= out <= 10_000_000):
        return None
    return {"input_tokens": inp, "output_tokens": out}


def retry_delay(value):
    try:
        return max(0, float(value))
    except (ValueError, TypeError):
        try:
            return max(0, parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return 0
