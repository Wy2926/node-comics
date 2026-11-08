import { appRelease } from '../data/app';

export type AppArch = typeof appRelease.architectures[number];
export interface AppPackage { arch: AppArch; version: string; build: number; url: string }
export const appManifestUrl = 'https://comics-updates.nodelane.net/stable/index.json';
const cacheLifetime = 5 * 60_000;
let cached: { packages: Map<AppArch, AppPackage>; expires: number } | undefined;
let pending: Promise<Map<AppArch, AppPackage>> | undefined;

export function parseAppManifest(value: unknown): Map<AppArch, AppPackage> {
  const manifest = value as { schema?: unknown; updates?: unknown } | null;
  if (manifest?.schema !== 1 || !Array.isArray(manifest.updates)) throw new Error('Invalid app manifest');
  const packages = new Map<AppArch, AppPackage>();
  for (const entry of manifest.updates) {
    if (entry?.platform !== 'android' || !appRelease.architectures.includes(entry.arch)) continue;
    const { arch, version, build, url } = entry;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)
      || !Number.isSafeInteger(build) || build < 1 || typeof url !== 'string') throw new Error('Invalid Android package');
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.origin !== 'https://github.com' || target.username || target.password || target.search || target.hash
      || !target.pathname.startsWith('/Wy2926/node-comics-app/releases/download/') || !target.pathname.endsWith('.apk')) throw new Error('Invalid APK URL');
    const previous = packages.get(arch);
    if (previous && previous.build === build && (previous.url !== url || previous.version !== version)) throw new Error('Conflicting Android package');
    if (!previous || previous.build < build) packages.set(arch, { arch, version, build, url });
  }
  if (appRelease.architectures.some(arch => !packages.has(arch))) throw new Error('Missing Android architecture');
  return packages;
}

// One in-flight request per page. The public HTTP cache and this bounded cache
// share a five-minute lifetime; explicit retry bypasses a failed HTTP response.
export function loadAppRelease(retry = false): Promise<Map<AppArch, AppPackage>> {
  if (pending) return pending;
  if (!retry && cached && cached.expires > Date.now()) return Promise.resolve(cached.packages);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  pending = (async () => {
    try {
      const response = await fetch(appManifestUrl, { signal: controller.signal, credentials: 'omit', cache: retry ? 'reload' : 'default' });
      if (!response.ok) throw new Error('App manifest unavailable');
      const packages = parseAppManifest(await response.json());
      cached = { packages, expires: Date.now() + cacheLifetime };
      return packages;
    } catch (error) {
      cached = undefined;
      throw error;
    } finally {
      clearTimeout(timeout);
      pending = undefined;
    }
  })();
  return pending;
}

export function setupAppDownloads() {
  for (const root of document.querySelectorAll<HTMLElement>('[data-app-release]')) {
    const links = root.querySelectorAll<HTMLAnchorElement>('[data-app-download]');
    const status = root.querySelector<HTMLElement>('[data-release-status]')!;
    const retry = root.querySelector<HTMLButtonElement>('[data-release-retry]')!;
    const load = async (refresh = false) => {
      for (const link of links) {
        link.hidden = true;
        link.removeAttribute('href');
      }
      retry.hidden = true;
      status.textContent = root.dataset.loading!;
      root.setAttribute('aria-busy', 'true');
      try {
        const packages = await loadAppRelease(refresh);
        for (const link of links) {
          const entry = packages.get(link.dataset.appArch as AppArch)!;
          link.href = entry.url;
          link.querySelector<HTMLElement>('[data-app-version]')!.textContent = `v${entry.version}`;
          link.hidden = false;
        }
        status.textContent = '';
      } catch {
        status.textContent = root.dataset.error!;
        retry.hidden = false;
      } finally {
        root.setAttribute('aria-busy', 'false');
      }
    };
    retry.addEventListener('click', () => { void load(true); });
    void load();
  }
}
