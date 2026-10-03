import {useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent} from 'react';
import {msg} from '../../i18n/runtime';
import {Icon} from '../../icons';
import {shortcutCommands, type ShortcutId, type ShortcutOverrides, type ShortcutScope as Scope} from '../../shortcuts/catalog';
import {bindingFromEvent, validateBinding} from '../../shortcuts/keys';
import {findConflict, resolveBindings} from '../../shortcuts/model';
import {browserShortcutBinding, canManageBrowserShortcuts, openBrowserShortcutSettings, readRegionShortcut} from '../../shortcuts/native';
import {useShortcutPreferences} from '../../shortcuts/react';
import {ShortcutBindingControl} from './ShortcutBindingControl';
import './shortcut-panel.css';

type Recording = {id: ShortcutId; index: number};
const scopes = ['global', 'app', 'reader', 'web'] as const;
const scopeIcons = {global: 'keyboard', app: 'home', reader: 'book', web: 'translate'};
const groups = scopes.map(scope => ({scope, commands: shortcutCommands.filter(command => command.scope === scope)}));
function scopeLabel(scope: Scope): string {
  switch (scope) {
    case 'global': return msg('通用操作');
    case 'app': return msg('首页与标签页');
    case 'reader': return msg('阅读器');
    case 'web': return msg('网页内翻译');
  }
}

/** The panel edits preferences only; command execution belongs to each surface. */
export function ShortcutPanel({onClose, initialScope}: {onClose: () => void; initialScope?: Scope}) {
  const {overrides, ready, error, save} = useShortcutPreferences();
  const [scope, setScope] = useState<Scope>(initialScope ?? 'global');
  const [recording, setRecording] = useState<Recording>();
  const [pending, setPending] = useState<ShortcutOverrides>();
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [validation, setValidation] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [browserShortcut, setBrowserShortcut] = useState<{value?: string; loading: boolean; failed: boolean}>({loading: canManageBrowserShortcuts(), failed: false});
  const [browserSettingsError, setBrowserSettingsError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), viewport = useRef<HTMLDivElement>(null);
  const sections = useRef<Partial<Record<Scope, HTMLElement>>>({}), frame = useRef(0), firstScope = useRef(initialScope ?? 'global'), opening = useRef(true);
  const resetButton = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const validationId = useId(), recordingHintId = useId(), titleId = useId(), sectionPrefix = useId();
  const current = pending ?? overrides, busy = phase === 'saving', loadFailed = error && !pending, disabled = !ready || busy || loadFailed;
  const nativeBinding = browserShortcutBinding(browserShortcut.value);

  useLayoutEffect(() => {
    const node = dialog.current!, scroll = viewport.current!;
    node.showModal();
    locate(firstScope.current);
    // Four section headers only; coalesce scrolling/resizing, never scan command rows.
    const resize = new ResizeObserver(() => {
      // Font wrapping and the shared scrollbar gutter can settle after showModal.
      // Keep the opening anchor until the first interaction, never while editing/browsing.
      if (opening.current) locate(firstScope.current);
      queueScope();
    });
    resize.observe(scroll);
    for (const section of Object.values(sections.current)) resize.observe(section);
    return () => {
      resize.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0;
      node.close();
      const previous = previousFocus.current;
      const target = previous instanceof HTMLElement && previous.isConnected && previous !== document.body ? previous
        : document.querySelector<HTMLElement>('[data-reader-settings-trigger]')
          ?? document.querySelector<HTMLElement>('.nc-preferences [aria-haspopup="dialog"]')
          ?? document.querySelector<HTMLElement>('.nc-app nav a, .nc-app nav button');
      target?.focus({preventScroll: true});
    };
  }, []);
  useEffect(() => { if (confirmReset) confirmButton.current?.focus({preventScroll: true}); }, [confirmReset]);
  useEffect(() => {
    if (!canManageBrowserShortcuts()) return;
    let active = true, request = 0;
    const refresh = () => {
      const latest = ++request;
      void readRegionShortcut().then(value => {
        if (active && latest === request) setBrowserShortcut({value, loading: false, failed: false});
      }).catch(() => {
        if (active && latest === request) setBrowserShortcut(previous => ({...previous, loading: false, failed: true}));
      });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);

  function locate(group: Scope) {
    const scroll = viewport.current, section = sections.current[group];
    if (!scroll || !section) return;
    const top = group === 'global' ? 0 : scroll.scrollTop + section.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20;
    scroll.scrollTo({top, behavior: 'instant'});
    setScope(group);
  }
  function queueScope() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const scroll = viewport.current;
      if (!scroll) return;
      const edge = scroll.getBoundingClientRect().top + 24;
      let active: Scope = 'global';
      if (scroll.scrollTop > 0 && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 2) active = 'web';
      else for (const group of scopes) if ((sections.current[group]?.getBoundingClientRect().top ?? Infinity) <= edge) active = group;
      setScope(active);
    });
  }

  async function commit(value: ShortcutOverrides) {
    setPending(value); setPhase('saving'); setValidation('');
    try {
      await save(value);
      setPending(undefined); setPhase('saved'); setRecording(undefined); setConfirmReset(false);
    } catch {
      // Keep the proposed configuration visible and available for an explicit retry.
      setPhase('failed');
    }
  }
  function stopRecording() { setRecording(undefined); setValidation(''); }
  function record(event: KeyboardEvent<HTMLButtonElement>, id: ShortcutId, index: number) {
    if (recording?.id !== id || recording.index !== index) return;
    if (event.key === 'Tab') { stopRecording(); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { stopRecording(); return; }
    if (event.repeat || event.nativeEvent.isComposing) return;
    const binding = bindingFromEvent(event.nativeEvent);
    if (!binding) return;
    const invalid = validateBinding(binding);
    if (invalid) {
      setValidation(invalid === 'reserved' ? msg('此组合键由浏览器或输入操作保留，请换一个。') : msg('请使用字母、数字、方向键或功能键，可搭配修饰键。'));
      return;
    }
    if (nativeBinding === binding) {
      setValidation(msg('快捷键与“{0}”冲突，请先修改该操作。', {'0': msg('划图翻译')}));
      return;
    }
    const conflict = findConflict(id, binding, current);
    if (conflict) {
      const command = shortcutCommands.find(item => item.id === conflict)!;
      setValidation(msg('快捷键与“{0}”冲突，请先修改该操作。', {'0': msg(command.label)}));
      return;
    }
    const bindings = [...resolveBindings(id, current)];
    bindings[index] = binding;
    void commit({...current, [id]: [...new Set(bindings)]});
  }
  function restore(id: ShortcutId) {
    const next = {...current}; delete next[id];
    if (nativeBinding && resolveBindings(id, next).includes(nativeBinding)) {
      setValidation(msg('快捷键与“{0}”冲突，请先修改该操作。', {'0': msg('划图翻译')}));
      return;
    }
    const conflict = resolveBindings(id, next).map(binding => findConflict(id, binding, next)).find(Boolean);
    if (conflict) {
      setValidation(msg('快捷键与“{0}”冲突，请先修改该操作。', {'0': msg(shortcutCommands.find(command => command.id === conflict)!.label)}));
      return;
    }
    void commit(next);
  }
  function cancelReset() { setConfirmReset(false); resetButton.current?.focus({preventScroll: true}); }
  function resetAll() {
    if (nativeBinding && shortcutCommands.some(command => resolveBindings(command.id, {}).includes(nativeBinding))) {
      setValidation(msg('快捷键与“{0}”冲突，请先修改该操作。', {'0': msg('划图翻译')}));
      return;
    }
    void commit({});
  }

  return <dialog ref={dialog} className="nc-shortcut-panel" aria-labelledby={titleId}
    onPointerDownCapture={() => {opening.current = false;}} onWheelCapture={() => {opening.current = false;}} onKeyDownCapture={() => {opening.current = false;}}
    onCancel={event => {
    event.preventDefault();
    if (recording) stopRecording(); else if (confirmReset) cancelReset(); else onClose();
  }} onKeyDown={event => {
      if (event.key === 'Escape' && confirmReset) { event.preventDefault(); event.stopPropagation(); cancelReset(); }
    }}>
    <header className="nc-shortcut-header">
      <div className="nc-shortcut-heading"><span className="nc-shortcut-emblem"><Icon name="keyboard" size={28}/></span><div>
        <h2 id={titleId}>{msg('键盘快捷键')}</h2>
        <p className="nc-shortcut-subtitle">{msg('快捷键保存在本机，按键盘位置识别，只在当前页面生效。输入文字时不会触发。')}</p>
      </div></div>
      <button type="button" className="nc-shortcut-close" aria-label={msg('关闭弹窗')} onClick={onClose}><Icon name="close"/></button>
    </header>
    <div className="nc-shortcut-layout">
      <nav className="nc-shortcut-nav" aria-label={msg('快捷键范围')}>
        <p className="nc-shortcut-nav-title">{msg('快捷键范围')}</p>
        {groups.map(({scope: item}) => <button type="button" key={item} className="nc-shortcut-anchor"
          aria-current={scope === item ? 'location' : undefined} aria-controls={`${sectionPrefix}-${item}`}
          onClick={() => {stopRecording(); locate(item);}}><Icon name={scopeIcons[item]} size={20}/><span className="nc-shortcut-anchor-label">{scopeLabel(item)}</span></button>)}
      </nav>
      <div ref={viewport} className="nc-shortcut-scroll" tabIndex={0} onScroll={queueScope}>
        <div className="nc-shortcut-intro">
          <p className="nc-shortcut-hint">{msg('每项可设置两个组合键。点击快捷键修改，或添加替代键。')}</p>
          <p className="nc-shortcut-hint">{msg('网页快捷键仅在已允许访问的网站生效。')}</p>
        </div>
        <div className="nc-shortcut-commands" aria-busy={busy}>
        {groups.map(({scope: group, commands}) => <section key={group} id={`${sectionPrefix}-${group}`} ref={node => {sections.current[group] = node ?? undefined;}}
          className="nc-shortcut-group" data-shortcut-scope={group} aria-label={scopeLabel(group)}>
          <header className="nc-shortcut-group-heading"><Icon name={scopeIcons[group]} size={20}/><h3>{scopeLabel(group)}</h3><span className="nc-shortcut-count" aria-hidden="true">{commands.length + (group === 'web' ? 1 : 0)}</span></header>
          <div className="nc-shortcut-group-body">
          {group === 'reader' && <p className="nc-shortcut-hint">{msg('选择译图后，随读预翻译后续页面；查看方式仅对此漫画生效。')}</p>}
          {group === 'web' && <>
            <p className="nc-shortcut-hint">{msg('开始划图由浏览器管理，以取得截图授权；不会随此面板恢复默认。')}</p>
            <div className="nc-shortcut-command nc-shortcut-native">
              <span className="nc-shortcut-command-label">{msg('划图翻译')}</span>
              <div className="nc-shortcut-assignment">
              <span className="nc-shortcut-native-key">{!canManageBrowserShortcuts() ? '—' : browserShortcut.loading ? msg('正在加载快捷键…') : browserShortcut.failed ? msg('无法读取浏览器快捷键。') : browserShortcut.value ? <kbd>{browserShortcut.value}</kbd> : msg('尚未设置')}</span>
              <button type="button" className="nc-shortcut-action" disabled={!canManageBrowserShortcuts()} onClick={() => {
                setBrowserSettingsError(false);
                void openBrowserShortcutSettings().catch(() => setBrowserSettingsError(true));
              }}>{msg('在浏览器中修改')}<Icon name="external" size={16}/></button>
              </div>
            </div>
            {browserSettingsError && <p className="nc-shortcut-error" role="alert">{msg('无法打开浏览器快捷键设置，请在扩展管理页修改。')}</p>}
          </>}
          {commands.map(command => {
            const bindings = resolveBindings(command.id, current), label = msg(command.label);
            return <div className="nc-shortcut-command" key={command.id} role="group" aria-label={label}>
              <div className="nc-shortcut-command-info"><span className="nc-shortcut-command-label">{label}</span>
                {!bindings.length && <span className="nc-shortcut-unassigned">{msg('尚未设置')}</span>}
              </div>
              <div className="nc-shortcut-assignment">
              <div className="nc-shortcut-bindings">
                {Array.from({length: Math.min(bindings.length + 1, 2)}, (_, index) => {
                  const binding = bindings[index], active = recording?.id === command.id && recording.index === index;
                  return <ShortcutBindingControl key={index} label={label} binding={binding} compact={!binding && bindings.length > 0} recording={active} disabled={disabled}
                    describedBy={active ? `${recordingHintId}${validation ? ' ' + validationId : ''}` : undefined} invalid={active && !!validation}
                    onStart={() => {setRecording({id: command.id, index}); setValidation(''); if (phase === 'saved') setPhase('idle');}}
                    onStop={stopRecording} onRecord={event => record(event, command.id, index)}
                    onRemove={() => {stopRecording(); void commit({...current, [command.id]: bindings.filter((_, position) => position !== index)});}}/>;
                })}
              </div>
              <button type="button" className="nc-shortcut-action nc-shortcut-restore" disabled={disabled || !Object.hasOwn(current, command.id)}
                aria-label={`${label} · ${msg('恢复默认')}`} title={`${label} · ${msg('恢复默认')}`} onClick={() => {stopRecording(); restore(command.id);}}><Icon name="refresh" size={18}/></button>
              </div>
            </div>;
          })}
          </div>
        </section>)}
        </div>
      </div>
    </div>
    <footer className="nc-shortcut-footer">
      <div className="nc-shortcut-feedback">
      <div className="nc-shortcut-status" role="status" aria-live="polite" aria-atomic="true">
        {!ready && !error && <span>{msg('正在加载快捷键…')}</span>}
        {phase === 'saving' && <span>{msg('正在保存设置…')}</span>}
        {phase === 'saved' && <span className="nc-shortcut-saved"><Icon name="check" size={16}/>{msg('快捷键已保存')}</span>}
      </div>
      {(phase === 'failed' || loadFailed) && <div className="nc-shortcut-error" role="alert">
        <span>{loadFailed ? msg('快捷键读取失败，请重新打开面板。') : msg('快捷键保存失败，请重试。')}</span>
        {pending && <button type="button" className="nc-shortcut-action" disabled={busy} onClick={() => void commit(pending)}>{msg('重新保存')}</button>}
      </div>}
      {validation && <p id={validationId} className="nc-shortcut-error" role="alert">{validation}</p>}
      {recording && <div className="nc-shortcut-recording" role="status"><p id={recordingHintId}>{msg('按下组合键；Esc 取消，Tab 离开。')}</p>
        <button type="button" className="nc-shortcut-action" onClick={stopRecording}>{msg('取消录制')}</button></div>}
      {confirmReset && <p>{msg('所有快捷键将恢复默认设置，是否继续？')}</p>}
      </div>
      <div className="nc-shortcut-footer-actions">
        {confirmReset ? <>
          <button type="button" className="nc-shortcut-action" disabled={busy} onClick={cancelReset}>{msg('取消')}</button>
          <button type="button" ref={confirmButton} className="nc-shortcut-action is-primary" disabled={disabled} onClick={resetAll}>{msg('恢复全部默认')}</button>
        </> : <button type="button" ref={resetButton} className="nc-shortcut-action" disabled={disabled || !Object.keys(current).length}
          onClick={() => {stopRecording(); setConfirmReset(true);}}><Icon name="refresh" size={16}/>{msg('恢复全部默认')}</button>}
      </div>
    </footer>
  </dialog>;
}
