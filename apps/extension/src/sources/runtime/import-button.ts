import { msg, subscribeLocale } from '../../i18n/runtime';
import { shadowThemeStyles } from '../../inline/shadow';
import { connectInlineTheme } from '../../inline/theme';
import styles from './import-button.css?inline';

export function mountSourceImportButton(parent: Element, {floating = false, findAlternatives = true}: {floating?: boolean; findAlternatives?: boolean} = {}) {
  const host = document.createElement('span');
  host.style.cssText =
    'all:initial!important;display:inline-block!important;max-width:100%!important;margin:12px 0!important';
  if (floating) host.style.cssText += 'position:fixed!important;left:16px!important;bottom:20px!important;z-index:2147483645!important;max-width:calc(100vw - 32px)!important;margin:0!important';
  const shadow = host.attachShadow({ mode: 'open' }),
    style = document.createElement('style');
  style.textContent = shadowThemeStyles(styles);
  const surface = document.createElement('div');
  surface.className = 'theme';
  const disconnectTheme = connectInlineTheme(surface);
  const button = document.createElement('button');
  button.type = 'button';
  const searchButton = findAlternatives ? document.createElement('button') : null;
  if (searchButton) {searchButton.type = 'button'; searchButton.className = 'search';}
  const status = document.createElement('span');
  status.className = 'status';
  status.id = 'import-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  button.setAttribute('aria-describedby', status.id);
  searchButton?.setAttribute('aria-describedby', status.id);
  const resetLabel = () => {
    button.textContent = 'NodeLane Comics · '+msg('导入/管理漫画');
    button.setAttribute('aria-label', button.textContent);
    if (searchButton) searchButton.textContent = msg('寻找其他语言');
    status.textContent = '';
  };
  resetLabel();
  const unsubscribe = subscribeLocale(resetLabel);
  const failed = (message: string) => {
    button.textContent = message;
    status.textContent = message;
  };
  let pending = false;
  const send = (trigger: HTMLButtonElement, type: string, onError: (message: string) => void) => {
    if (pending) return;
    pending = true;
    resetLabel();
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    void chrome.runtime
      .sendMessage({ type })
      .then((response) => {
        if (!response?.ok)
          onError(typeof response?.error === 'string' ? response.error : msg('请通过插件弹窗重试'));
      })
      .catch(() => onError(msg('请通过插件弹窗重试')))
      .finally(() => {
        pending = false;
        trigger.disabled = false;
        trigger.removeAttribute('aria-busy');
      });
  };
  button.onclick = () => send(button, 'NC_IMPORT_CURRENT', failed);
  if (searchButton) searchButton.onclick = () => send(searchButton, 'NC_SEARCH_CURRENT', message => {status.textContent = message;});
  surface.append(button);
  if (searchButton) surface.append(searchButton);
  surface.append(status);
  shadow.append(style, surface);
  parent.append(host);
  return () => {
    host.remove();
    unsubscribe();
    disconnectTheme();
  };
}
