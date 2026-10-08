import {Children, Fragment, isValidElement, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode} from 'react';
import {Icon} from '../icons';
import {menuPosition, visibleViewport} from './visual-viewport';
import './select.css';

/** Value-only change contract; this is deliberately not a native select event. */
export type SelectChangeEvent = {
  target: {value: string; name: string; id: string};
  currentTarget: {value: string; name: string; id: string};
};
export type SelectProps = Omit<ComponentPropsWithoutRef<'button'>, 'value' | 'defaultValue' | 'onChange' | 'children' | 'type'> & {
  value: string | number;
  onChange: (event: SelectChangeEvent) => void;
  children?: ReactNode;
  /** Custom button content; option labels still drive selection and type-ahead. */
  trigger?: ReactNode;
  placement?: 'auto' | 'left';
  menuWidth?: number;
};
type SelectOptionProps = ComponentPropsWithoutRef<'option'> & {icon?: ReactNode};
type Option = {value: string; label: string; disabled: boolean; icon?: ReactNode};

/** Declarative option for Select. Icons are decorative; labels stay plain text for type-ahead. */
export function SelectOption(_props: SelectOptionProps) { return null; }

function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{children?: ReactNode}>(child)
    ? textContent(child.props.children) : String(child)).join('');
}

function readOptions(children: ReactNode, disabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<SelectOptionProps>(child)) return [];
    if (child.type === Fragment || child.type === 'optgroup') return readOptions(child.props.children, disabled || !!child.props.disabled);
    if ((child.type !== 'option' && child.type !== SelectOption) || child.props.hidden) return [];
    const label = child.props.label ?? textContent(child.props.children);
    return [{value: String(child.props.value ?? textContent(child.props.children)), label, disabled: disabled || !!child.props.disabled, icon: child.props.icon}];
  });
}

/** Single selection. Focus stays on the button; Escape cancels, Enter/Tab commit. */
export function Select({value, onChange, children, trigger, placement = 'auto', menuWidth = 180, disabled, id, name, className = '', onKeyDown, onClick, onBlur, ...props}: SelectProps) {
  const generatedId = useId(), buttonId = id ?? `nc-select-${generatedId}`, listId = `${buttonId}-list`;
  const buttonRef = useRef<HTMLButtonElement>(null), listRef = useRef<HTMLSpanElement>(null);
  const touchingList = useRef(false);
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const [implicitLabel, setImplicitLabel] = useState<string>();
  const search = useRef({text: '', time: 0});
  const options = readOptions(children), selected = options.findIndex(option => option.value === String(value));
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const unavailable = disabled || !enabled.length;
  const expanded = open && !unavailable;
  const activeIndex = enabled.includes(active) ? active : enabled.includes(selected) ? selected : enabled[0];
  const label = props['aria-label'] ?? (props['aria-labelledby'] ? undefined : implicitLabel);

  useLayoutEffect(() => {
    if (props['aria-label'] || props['aria-labelledby']) return;
    // A labelable button includes its own text in the label name, unlike a native select.
    // Read just the label copy; cloning avoids mutating React's text nodes on locale changes.
    const text = Array.from(buttonRef.current?.labels ?? []).map(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.nc-select, .nc-select-list, input, [aria-hidden=true]').forEach(node => node.remove());
      return copy.textContent?.replace(/\s+/g, ' ').trim();
    }).filter(Boolean).join(' ');
    setImplicitLabel(text || undefined);
  });

  function close() {
    touchingList.current = false;
    setOpen(false);
    search.current = {text: '', time: 0};
  }
  function restoreTouchFocus() {
    if (!touchingList.current) return;
    touchingList.current = false;
    buttonRef.current?.focus({preventScroll: true});
  }
  function show(index = enabled.includes(selected) ? selected : enabled[0]) {
    if (unavailable) return;
    search.current = {text: '', time: 0};
    setActive(index);
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (unavailable || !option || option.disabled) return;
    close();
    if (option.value !== String(value)) {
      const target = {value: option.value, name: name ?? '', id: buttonId};
      onChange({target, currentTarget: target});
    }
  }

  useLayoutEffect(() => {
    const button = buttonRef.current, list = listRef.current;
    if (!button || !list || !expanded) return;
    // Keeping the popover in the DOM subtree preserves dialog interactivity and theme tokens.
    // The browser's top layer escapes ancestor overflow without a body portal.
    const nativePopover = typeof list.showPopover === 'function';
    if (nativePopover) list.showPopover();
    function position() {
      if (!button || !list) return;
      const bounds = visibleViewport(), rect = button.getBoundingClientRect();
      // Set width before measuring wrapped labels, then keep the list above the soft keyboard.
      list.style.width = `${Math.max(0, Math.min(Math.max(rect.width, menuWidth), bounds.width - 16))}px`;
      const position = menuPosition(rect, bounds, menuWidth, list.scrollHeight + 4, placement);
      for (const [key, value] of Object.entries(position)) list.style[key as 'left' | 'top' | 'width' | 'maxHeight'] = `${value}px`;
    }
    position();
    const resize = new ResizeObserver(position);
    resize.observe(button);
    const scroll = (event: Event) => { if (event.target !== list) position(); };
    const dismiss = (event: PointerEvent) => { if (!list.contains(event.target as Node) && !button.contains(event.target as Node)) close(); };
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', scroll, true);
    if (!nativePopover) document.addEventListener('pointerdown', dismiss);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', dismiss);
      if (nativePopover && list.matches(':popover-open')) list.hidePopover();
    };
  }, [expanded, placement, menuWidth]);

  useLayoutEffect(() => {
    const list = listRef.current, option = list?.querySelectorAll<HTMLElement>('.nc-select-option')[activeIndex];
    if (!expanded || !list || !option) return;
    // scrollIntoView would also move the reader/dialog behind the list.
    const item = option.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (item.top < viewport.top + 4) list.scrollTop -= viewport.top + 4 - item.top;
    else if (item.bottom > viewport.bottom - 4) list.scrollTop += item.bottom - viewport.bottom + 4;
  }, [expanded, activeIndex]);

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || unavailable || event.nativeEvent.isComposing) return;
    // Reader shortcuts must not turn pages or toggle originals during type-ahead.
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Tab') {
      if (expanded) choose(activeIndex);
      return; // Keep the browser's normal forward/backward focus traversal.
    }
    if (event.key === 'Escape') {
      if (expanded) { event.preventDefault(); close(); }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Enter' || event.key === ' ') {
        if (expanded) choose(activeIndex); else show();
      } else if (event.key === 'Home' || event.key === 'End') {
        const index = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
        if (expanded) setActive(index); else show(index);
      } else if (!expanded) show();
      else setActive(enabled[Math.max(0, Math.min(enabled.length - 1, enabled.indexOf(activeIndex) + (event.key === 'ArrowDown' ? 1 : -1)))]);
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    const now = Date.now(), letter = event.key.toLocaleLowerCase();
    const text = now - search.current.time > 700 ? letter : search.current.text + letter;
    const query = [...text].every(character => character === letter) ? letter : text;
    const start = expanded ? activeIndex : selected;
    const ordered = [...enabled.filter(index => index > start), ...enabled.filter(index => index <= start)];
    if (query.length > 1 && enabled.includes(start)) ordered.unshift(start);
    const match = ordered.find(index => options[index].label.trim().toLocaleLowerCase().startsWith(query));
    if (match !== undefined) {
      if (!expanded) show(match); else setActive(match);
    }
    search.current = {text, time: now};
  }

  return <>
    <button {...props} ref={buttonRef} id={buttonId} type="button" name={name} value={value} data-value={value} aria-label={label}
      className={`nc-select ${className}`} disabled={unavailable} role="combobox" aria-haspopup="listbox"
      aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && activeIndex !== undefined ? `${listId}-${activeIndex}` : undefined}
      onKeyDown={keyDown} onBlur={event => { if (!touchingList.current) close(); onBlur?.(event); }}
      onClick={event => { onClick?.(event); if (!event.defaultPrevented) { event.currentTarget.focus({preventScroll: true}); if (expanded) close(); else show(); } }}>
      {trigger ?? <><span className="nc-select-content">{options[selected]?.icon && <span className="nc-select-icon" aria-hidden="true">{options[selected].icon}</span>}<span className="nc-select-value">{options[selected]?.label ?? String(value)}</span></span>
      <Icon name="chevron" size={16} className="nc-select-chevron"/></>}
    </button>
    {name && <input type="hidden" name={name} value={value} disabled={unavailable} form={props.form}/>}
    <span ref={listRef} id={listId} popover="auto" role="listbox" className="nc-select-list" hidden={!expanded}
      data-popover-fallback-open={expanded && typeof HTMLElement.prototype.showPopover !== 'function' || undefined}
      aria-labelledby={buttonId}
      onToggle={() => { if (listRef.current && typeof listRef.current.showPopover === 'function' && !listRef.current.matches(':popover-open')) close(); }}
      onPointerDown={event => { if (event.pointerType === 'touch') touchingList.current = true; else event.preventDefault(); }}
      onPointerUp={restoreTouchFocus} onPointerCancel={restoreTouchFocus}
      onMouseDown={event => {
        // Firefox extension pages ignore pointerdown.preventDefault() (Mozilla bug 1484186).
        event.preventDefault();
      }}>
      {options.map((option, index) => <span key={option.value} id={`${listId}-${index}`} role="option" data-value={option.value}
        aria-selected={index === selected} aria-disabled={option.disabled || undefined}
        className="nc-select-option" data-active={expanded && index === activeIndex || undefined}
        onPointerMove={event => { if (event.pointerType !== 'touch' && !option.disabled) setActive(index); }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index); }}>
        <span className="nc-select-content">{option.icon && <span className="nc-select-icon" aria-hidden="true">{option.icon}</span>}<span className="nc-select-label">{option.label}</span></span><Icon name="check" size={16} className="nc-select-check"/>
      </span>)}
    </span>
  </>;
}
