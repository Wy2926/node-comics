"""OpenAI text channel. One request, no SDK retries or configuration lookups."""
import json
import time
from typing import Literal
from urllib.parse import urlsplit
import httpx
from pydantic import Field, field_validator
from ..errors import ProcessingError
from .images import read_bounded
from .transport import CheckedTransport
from .text import TextError, TextResponse, TranslationConfig, messages, safe_usage, retry_delay


class OpenAITextConfig(TranslationConfig):
    base_url: str = Field(default='https://api.openai.com/v1', max_length=1000)
    protocol: Literal['chat_completions', 'responses'] = 'chat_completions'
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


def translate(segments, language, profile, api_key):
    chat = profile["protocol"] == "chat_completions"
    payload = {"model": profile["model"], "stream": False, "store": False}
    if chat:
        payload.update(messages=messages(segments, language), max_completion_tokens=profile["max_output_tokens"])
    else:
        payload.update(input=messages(segments, language), max_output_tokens=profile["max_output_tokens"], store=False)
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
                raw = read_bounded(response, 128 * 1024, time.monotonic() + profile["timeout_seconds"])
        data = json.loads(raw)
        usage = safe_usage(data.get("usage"))
        request_id = request_id or (data.get("id", "")[:200] if isinstance(data.get("id"), str) else None)
        try:
            if chat:
                choice = data["choices"][0]
                content = choice["message"]["content"]
                complete = choice.get("finish_reason") == "stop"
            else:
                content = ''.join(part["text"] for item in data.get("output", []) if item.get("type") == "message"
                                  for part in item.get("content", []) if part.get("type") == "output_text")
                complete = data.get("status") == "completed"
            if not complete or not isinstance(content, str):
                raise ValueError()
        except (ValueError, KeyError, IndexError, TypeError):
            raise TextError("TEXT_INCOMPLETE", "文本响应被截断或没有译文，将在次数与处理时限内重试", retryable=True, usage=usage, request_id=request_id) from None
        return TextResponse(content, usage, request_id)
    except TextError:
        raise
    except (httpx.HTTPError, OSError):
        raise TextError("TEXT_TRANSPORT_FAILED", "文本请求超时或连接中断，将在次数与处理时限内重试", retryable=True) from None
    except (ValueError, TypeError, AttributeError, ProcessingError):
        raise TextError("TEXT_INVALID_RESPONSE", "文本服务响应无效，将在次数与处理时限内重试", retryable=True) from None
