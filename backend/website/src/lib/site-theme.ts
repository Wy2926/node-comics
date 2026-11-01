export type SiteTheme = 'system' | 'paper' | 'midnight';
export const themeKey = 'nc-site-theme';
export function themePreference(value: string | null): SiteTheme {
  return value === 'paper' || value === 'midnight' ? value : 'system';
}
export function setupSiteTheme() {
  const root = document.documentElement;
  const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!toggle) return;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference: SiteTheme = 'system';
  try { preference = themePreference(localStorage.getItem(themeKey)); } catch { /* System works without storage. */ }
  const apply = () => {
    const dark = preference === 'midnight' || preference === 'system' && system.matches;
    root.dataset.siteTheme = dark ? 'midnight' : 'paper';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.title = (dark ? toggle.dataset.themeLight : toggle.dataset.themeDark)!;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111820' : '#f6f8fc');
  };
  toggle.addEventListener('click', () => {
    preference = root.dataset.siteTheme === 'midnight' ? 'paper' : 'midnight';
    try { localStorage.setItem(themeKey, preference); } catch { /* Keep this page's choice. */ }
    apply();
  });
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === themeKey || event.key === null) { preference = themePreference(event.newValue); apply(); }
  });
  apply();
  toggle.hidden = false;
}
