import {useId, useLayoutEffect, useRef, useState, type KeyboardEvent} from 'react';
import {getLocale, msg} from '../i18n/runtime';
import {pricingUrl} from '../billing';
import {Icon} from '../icons';
import type {ModelSelection} from '../translation/channels/contracts';
import {selectedModelAvailable, translationModelChoices} from '../../../../backend/shared/translation-models';
import {menuPosition, visibleViewport} from './visual-viewport';
import './select.css';
import './translation-models.css';

export function TranslationModelPicker({selection}: {selection?: ModelSelection}) {
  return selection ? <ModelPicker selection={selection} /> : null;
}

function ModelPicker({selection}: {selection: ModelSelection}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const {models, value} = selection,
    selected = models?.find((model) => model.id === value);
  const choices = translationModelChoices(models, msg('自动选择（默认）'), value);
  const available = selectedModelAvailable(models, value);
  function close(restore = true) {
    setOpen(false);
    if (restore) trigger.current?.focus({preventScroll: true});
  }
  async function choose(value: string) {
    setSaving(true);
    setError('');
    try {
      await selection.select(value || undefined);
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  useLayoutEffect(() => {
    const button = trigger.current,
      panel = menu.current;
    if (!open || !button || !panel) return;
    const native = typeof panel.showPopover === 'function';
    if (native) panel.showPopover();
    const position = () => {
      const viewport = visibleViewport(),
        rect = button.getBoundingClientRect();
      panel.style.width = `${Math.max(0, Math.min(rect.width, viewport.width - 16))}px`;
      const bounds = menuPosition(rect, viewport, rect.width, Math.min(panel.scrollHeight + 4, 480));
      for (const [key, value] of Object.entries(bounds))
        panel.style[key as 'left' | 'top' | 'width' | 'maxHeight'] = `${value}px`;
    };
    position();
    (
      panel.querySelector<HTMLButtonElement>('button[aria-pressed=true]:not(:disabled)') ??
      panel.querySelector<HTMLElement>('button:not(:disabled),a')
    )?.focus({preventScroll: true});
    const resize = new ResizeObserver(position);
    resize.observe(button);
    const scroll = (event: Event) => {
      if (event.target !== panel) position();
    };
    const dismiss = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);
    };
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', scroll, true);
    if (!native) document.addEventListener('pointerdown', dismiss);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', dismiss);
      if (native && panel.matches(':popover-open')) panel.hidePopover();
    };
  }, [open]);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey)
      return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...menu.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')],
      index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    items[next]?.focus({preventScroll: true});
    // Scroll only this menu; never move the comic behind it.
    const item = items[next]?.getBoundingClientRect(),
      panel = menu.current!,
      bounds = panel.getBoundingClientRect();
    if (item && item.bottom > bounds.bottom) panel.scrollTop += item.bottom - bounds.bottom + 8;
    if (item && item.top < bounds.top) panel.scrollTop -= bounds.top - item.top + 8;
  }
  return (
    <div className="nc-model-picker">
      <span id={id + '-label'}>{msg('翻译模型')}</span>
      <button
        ref={trigger}
        type="button"
        className="nc-select nc-model-trigger"
        aria-label={msg('翻译模型')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        title={msg('更换模型仅影响新任务；已有译图需手动重新翻译。')}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        <strong>{value ? (selected?.name ?? value) : msg('自动选择（默认）')}</strong>
        <small data-available={available}>{available ? msg('可用') : msg('不可用')}</small>
        <Icon name="chevron" size={16} className="nc-select-chevron" />
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="dialog"
        aria-labelledby={id + '-label'}
        className="nc-select-list nc-model-menu"
        hidden={!open}
        data-popover-fallback-open={(open && typeof HTMLElement.prototype.showPopover !== 'function') || undefined}
        onToggle={(event) => {
          if (event.newState === 'closed') setOpen(false);
        }}
        onKeyDown={navigate}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget) &&
            event.relatedTarget !== trigger.current
          )
            close(false);
        }}
      >
        <div className="nc-model-options">
          {choices.map((model) => {
            const content = (
              <>
                <strong>
                  {model.name}
                  {model.available ? (
                    (value ?? '') === model.id && <Icon name="check" size={16} />
                  ) : (
                    <small className="nc-model-upgrade">{msg('升级')} ↗</small>
                  )}
                </strong>
                <span className="nc-model-badges">
                  {model.id && (model.id !== value || selected) && (
                    <small>{model.requires_paid ? msg('付费权益') : msg('免费')}</small>
                  )}
                  <small data-available={model.available}>{model.available ? msg('可用') : msg('不可用')}</small>
                </span>
              </>
            );
            return (
              <div
                className="nc-model-option"
                key={model.id}
                data-available={model.available}
                data-paid={model.requires_paid}
              >
                {model.available ? (
                  <button
                    className="nc-select-option nc-model-choice"
                    type="button"
                    disabled={saving}
                    aria-pressed={(value ?? '') === model.id}
                    onClick={() => void choose(model.id)}
                  >
                    {content}
                  </button>
                ) : (
                  <a
                    className="nc-select-option nc-model-choice"
                    href={pricingUrl(getLocale())}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {content}
                  </a>
                )}
              </div>
            );
          })}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
