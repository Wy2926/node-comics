export interface AutoTranslateSite {
  hostname: string;
  enabled: boolean;
  scope: 'domain' | 'directory' | 'regex';
  value: string;
}

/** These rules authorize a top-level tab URL, never an image or CDN URL. */
export function automaticTabUrl(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hostname.includes('*') ? url : undefined;
  } catch { return undefined; }
}

export function siteFromInput(value: string): URL | undefined {
  const input = value.trim();
  return automaticTabUrl(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : 'https://' + input);
}

export function directoryPath(value: string): string | undefined {
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\\s]/.test(path)) return;
  try {
    const normalized = new URL(path, 'https://directory.invalid').pathname;
    return normalized.replace(/\/+$/, '') || '/';
  } catch { return undefined; }
}

export function tabDirectories(url: URL): string[] {
  const parts = url.pathname.split('/').filter(Boolean);
  if (!url.pathname.endsWith('/')) parts.pop();
  return parts.map((_, i) => '/' + parts.slice(0, parts.length - i).join('/'));
}

export function normalizeAutoTranslateSites(value: unknown): AutoTranslateSite[] {
  if (!Array.isArray(value)) return [];
  const sites = new Map<string, AutoTranslateSite>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.hostname !== 'string') continue;
    const url = automaticTabUrl('https://' + item.hostname);
    if (!url || url.host !== item.hostname.toLowerCase() || url.pathname !== '/' || url.search || url.hash) continue;
    if (!['domain', 'directory', 'regex'].includes(item.scope)) continue;
    const scope = item.scope as AutoTranslateSite['scope'];
    const input = typeof item.value === 'string' ? item.value : '';
    const rule = scope === 'directory' ? directoryPath(input) : scope === 'regex' ? input.trim() : '';
    if (rule === undefined || scope === 'regex' && (!rule || rule.length > 300)) continue;
    sites.set(url.hostname, {hostname: url.hostname, enabled: item.enabled === true, scope, value: rule});
  }
  return [...sites.values()];
}

/** undefined means the hostname passed and a bounded regular-expression check is needed. */
export function matchAutomaticTab(site: AutoTranslateSite, url: URL): boolean | undefined {
  if (!site.enabled || site.hostname !== url.hostname) return false;
  if (site.scope === 'domain') return true;
  if (site.scope === 'regex') return undefined;
  const path = directoryPath(site.value);
  return !!path && (path === '/' || url.pathname === path || url.pathname.startsWith(path + '/'));
}
