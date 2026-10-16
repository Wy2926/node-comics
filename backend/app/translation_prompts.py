"""Editable translation guidance; wire contracts remain in each caller."""

MAX_PROMPT_LENGTH = 8000

COMIC_TRANSLATION_PROMPT = """Translate comic text naturally and faithfully, preserving meaning and character voice.
Keep names and recurring terms consistent; use established translations for clearly identified works, otherwise retain or transliterate names.
Convey humor, wordplay and cultural references by context and intended effect, not just literal wording.
Preserve emotion, politeness, implied meaning and expressive sound effects. Keep dialogue concise and complete."""

COMIC_TITLE_PROMPT = """Translate the comic title naturally for search, preserving its meaning and distinctive names. Use an established translation when known."""

PROMPT_DEFAULTS = {
    'comic_translation_prompt': COMIC_TRANSLATION_PROMPT,
    'comic_title_prompt': COMIC_TITLE_PROMPT,
}
