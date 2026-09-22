import { msg, subscribeLocale } from '../../i18n/runtime';
import { shadowThemeStyles } from '../../inline/shadow';
import { connectInlineTheme } from '../../inline/theme';
import styles from './import-button.css?inline';

export function mountSourceImportButton(parent: Element) {
  const host = document.createElement('span');
  host.style.cssText =
    'all:initial!important;display:inline-block!important;max-width:100%!important;margin:12px 0!important';
  const shadow = host.attachShadow({ mode: 'open' }),
    style = document.createElement('style');
  style.textContent = shadowThemeStyles(styles);
  const surface = document.createElement('div');
  surface.className = 'theme';
  const disconnectTheme = connectInlineTheme(surface);
  const button = document.createElement('button');
  button.type = 'button';
  const status = document.createElement('span');
  status.className = 'status';
  status.id = 'import-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  button.setAttribute('aria-describedby', status.id);
  const resetLabel = () => {
    button.textContent = msg('NodeLane Comics · 导入／管理漫画');
    button.setAttribute('aria-label', button.textContent);
    status.textContent = '';
  };
  resetLabel();
  const unsubscribe = subscribeLocale(resetLabel);
  const failed = (message: string) => {
    button.textContent = message;
    status.textContent = message;
  };
  button.onclick = () => {
    resetLabel();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    void chrome.runtime
      .sendMessage({ type: 'NC_IMPORT_CURRENT' })
      .then((response) => {
        if (!response?.ok)
          failed(typeof response?.error === 'string' ? response.error : msg('请通过插件弹窗重试'));
      })
      .catch(() => failed(msg('请通过插件弹窗重试')))
      .finally(() => {
        button.disabled = false;
        button.removeAttribute('aria-busy');
      });
  };
  surface.append(button, status);
  shadow.append(style, surface);
  parent.append(host);
  return () => {
    host.remove();
    unsubscribe();
    disconnectTheme();
  };
}
