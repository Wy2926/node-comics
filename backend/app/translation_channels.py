"""Channel registry: adding a source never changes the durable translation loop."""
from dataclasses import dataclass
from typing import Protocol
from .adapters.openai_text import OpenAITextConfig, call_messages
from .adapters.llm import LLMConfig, Message, TextResponse


class ChannelCall(Protocol):
    def __call__(self, messages: list[Message], profile: dict, api_key: str, *,
                 json_schema: dict | None = None) -> TextResponse: ...


@dataclass(frozen=True)
class TranslationChannel:
    label: str
    config_type: type[LLMConfig]
    protocols: tuple[str, ...]
    call: ChannelCall


CHANNELS = {
    'openai': TranslationChannel('OpenAI', OpenAITextConfig, ('chat_completions', 'responses'), call_messages),
}
