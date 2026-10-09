import {useRef} from 'react';
import type {TranslationModelChoice} from '../../../shared/translation-models';
import {translationModelChoices} from '../../../shared/translation-models';
import type {ModelCopy} from '../i18n/translation-models';

export default function TranslationModelPicker({
  models,
  value,
  onChange,
  copy: t,
  upgradeUrl,
  disabled = false,
}: {
  models?: TranslationModelChoice[];
  value?: string;
  onChange(value?: string): void;
  copy: ModelCopy;
  upgradeUrl: string;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDetailsElement>(null),
    selected = models?.find((model) => model.id === value);
  const choices = translationModelChoices(models, t.automatic, value);
  return (
    <div className="translation-model-picker">
      <span>{t.label}</span>
      <details
        ref={root}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && root.current?.open) {
            event.preventDefault();
            event.stopPropagation();
            root.current.open = false;
            root.current.querySelector('summary')?.focus();
          }
        }}
      >
        <summary aria-label={t.label}>{value ? (selected?.name ?? value) : t.automatic}</summary>
        <div className="translation-model-options" role="group" aria-label={t.label}>
          {choices.map((model) => {
            const content = (
              <>
                <strong>
                  {model.name}
                  {!model.available && <span className="translation-model-upgrade">{t.upgrade} ↗</span>}
                </strong>
                <span className="translation-model-badges">
                  {model.id && (model.id !== value || selected) && (
                    <small>{model.requires_paid ? t.paid : t.free}</small>
                  )}
                  <small>{model.available ? t.available : t.unavailable}</small>
                </span>
              </>
            );
            return (
              <div
                className="translation-model-option"
                key={model.id}
                data-available={model.available}
                data-paid={model.requires_paid}
              >
                {model.available ? (
                  <button
                    className="translation-model-choice"
                    type="button"
                    disabled={disabled}
                    aria-pressed={(value ?? '') === model.id}
                    onClick={() => {
                      onChange(model.id || undefined);
                      root.current!.open = false;
                    }}
                  >
                    {content}
                  </button>
                ) : (
                  <a className="translation-model-choice" href={upgradeUrl} target="_blank" rel="noopener noreferrer">
                    {content}
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
