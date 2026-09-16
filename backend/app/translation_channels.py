"""Channel registry: adding a source never changes the durable translation loop."""
from dataclasses import dataclass
from typing import Callable
from .adapters.openai_text import OpenAITextConfig, translate
from .adapters.text import TranslationConfig


@dataclass(frozen=True)
class TranslationChannel:
    label: str
    config_type: type[TranslationConfig]
    protocols: tuple[str, ...]
    translate: Callable


CHANNELS = {
    'openai': TranslationChannel('OpenAI', OpenAITextConfig, ('chat_completions', 'responses'), translate),
}
