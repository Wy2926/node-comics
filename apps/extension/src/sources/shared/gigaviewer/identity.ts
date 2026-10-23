import type {SourceLocation} from '../../contracts/definition';

/** Pure URL rules. Each verified site supplies its own origin and identity namespace. */
export function gigaViewerIdentity(sourceId: string, origin: string, binding = `nodelane-${sourceId}`) {
  const bindingPattern = new RegExp(`^#${binding}=([1-9]\\d{0,24})$`);
  const seriesKey = (id: string) => `${sourceId}:series:${id}`;
  const catalogUrl = (id: string) => `${origin}/series/${id}/first_episode`;
  const episodeUrl = (id: string, series?: string) => `${origin}/episode/${id}${series ? `#${binding}=${series}` : ''}`;
  function episode(url: URL) {
    if (url.origin !== origin || url.username || url.password) return;
    return /^\/episode\/([1-9]\d{0,24})\/?$/.exec(url.pathname)?.[1];
  }
  function location(url: URL) {
    if (url.origin !== origin || url.username || url.password) return null;
    const series = /^\/series\/([1-9]\d{0,24})\/first_episode\/?$/.exec(url.pathname)?.[1];
    if (series) return {series, catalog: true as const};
    const id = episode(url);
    if (!id) return null;
    const parent = bindingPattern.exec(url.hash);
    if (url.hash.startsWith(`#${binding}`) && !parent) return null;
    return {episode: id, series: parent?.[1], catalog: false as const};
  }
  function identify(url: URL): SourceLocation | null {
    if (url.origin !== origin || url.username || url.password) return null;
    const loc = location(url);
    if (!loc) return {sourceId, kind: 'other', url: url.href, pageKey: `${sourceId}:${url.href}`};
    return {sourceId, kind: loc.catalog ? 'catalog' : 'reader', url: url.href,
      pageKey: loc.catalog ? seriesKey(loc.series) : `${sourceId}:episode:${loc.episode}`,
      ...(loc.series ? {catalog: {key: seriesKey(loc.series), url: catalogUrl(loc.series)}} : {})};
  }
  return {sourceId, origin, seriesKey, catalogUrl, episodeUrl, episode, location, identify};
}
export type GigaViewerIdentity = ReturnType<typeof gigaViewerIdentity>;
