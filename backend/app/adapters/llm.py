"""One message-based LLM request; prompts, parsing and retries belong to callers."""
from dataclasses import dataclass
from typing import Literal, TypedDict
from pydantic import BaseModel, ConfigDict, Field
from ..errors import ProcessingError


class Message(TypedDict):
    role: Literal['system', 'user', 'assistant']
    content: str


class LLMConfig(BaseModel):
    """Common connection and response bounds; business policies belong to callers."""
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True, hide_input_in_errors=True)
    model: str = Field(min_length=1, max_length=120)
    timeout_seconds: int = Field(default=60, ge=1, le=180, strict=True)
    max_output_tokens: int = Field(default=1024, ge=128, le=8192, strict=True)


class TextError(ProcessingError):
    def __init__(self, code, message, *, retryable=False, retry_after=0, **kwargs):
        super().__init__(code, message, **kwargs)
        self.retryable, self.retry_after = retryable, retry_after


@dataclass
class TextResponse:
    content: str
    usage: dict | None
    request_id: str | None


def call_messages(messages: list[Message], profile: dict) -> TextResponse:
    from ..translation_channels import CHANNELS
    from ..translation_providers import resolve_credentials
    channel = CHANNELS.get(profile['channel'])
    if channel is None:
        raise TextError('TEXT_CHANNEL_UNSUPPORTED', '文本渠道尚未实现')
    return channel.call(messages, profile, resolve_credentials(profile))
