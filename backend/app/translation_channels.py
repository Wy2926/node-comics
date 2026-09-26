"""Channel registry: adding a source never changes the durable translation loop."""
from dataclasses import dataclass
from typing import Callable
from .adapters.openai_text import OpenAITextConfig, call_messages
from .adapters.llm import LLMConfig, Message, TextResponse


@dataclass(frozen=True)
class TranslationChannel:
    label: str
    config_type: type[LLMConfig]
    protocols: tuple[str, ...]
    call: Callable[[list[Message], dict, str], TextResponse]


CHANNELS = {
    'openai': TranslationChannel('OpenAI', OpenAITextConfig, ('chat_completions', 'responses'), call_messages),
}
