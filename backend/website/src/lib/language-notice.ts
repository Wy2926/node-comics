import {basePath, languageNames, locales, type Locale} from '../i18n/locales';
import {languageSuggestion, languageTarget, preferenceCookie} from './language-preference';
import {bindHeaderMenus} from './header-menu';

bindHeaderMenus(document);

const notice = document.querySelector<HTMLElement>('[data-language-notice]');
const dismissedKey = 'nc-site-language-dismissed';
function remember(locale: Locale) {
  try { document.cookie = `${preferenceCookie}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* Navigation does not depend on storage. */ }
}
// Ordinary links remain usable when JavaScript or cookies are unavailable.
document.querySelectorAll<HTMLAnchorElement>('.language-menu a[lang]').forEach(link => {
  const locale = link.lang as Locale;
  if (locales.includes(locale)) {
    if (!/^\/(?:auth|payment)(?:\/|$)/.test(basePath(location.pathname))) {
      const target = new URL(link.href);
      link.href = target.pathname + location.search + location.hash;
    }
    link.addEventListener('click', () => remember(locale));
  }
});
if (notice && notice.dataset.enabled === 'true') {
  let dismissed: string | undefined;
  try { dismissed = sessionStorage.getItem(dismissedKey) ?? undefined; } catch { /* Storage is optional. */ }
  let cookie = '';
  try { cookie = document.cookie; } catch { /* Cookie access is optional. */ }
  const target = languageSuggestion(location.pathname, notice.dataset.locale as Locale, navigator.languages, cookie, dismissed);
  if (target) {
    const message = notice.querySelector<HTMLElement>('[data-language-message]')!;
    const link = notice.querySelector<HTMLAnchorElement>('a')!;
    message.textContent = notice.dataset.message!.replace('{language}', languageNames[target]);
    link.href = languageTarget(new URL(location.href), target);
    link.lang = target;
    link.addEventListener('click', () => remember(target));
    notice.querySelector('button')!.addEventListener('click', () => {
      notice.hidden = true;
      try { sessionStorage.setItem(dismissedKey, target); } catch { /* Dismissal still works on this page. */ }
    });
    notice.hidden = false;
  }
}
