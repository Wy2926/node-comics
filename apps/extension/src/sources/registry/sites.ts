import type { SourceDefinition, SourceSite, SourceSiteAccessTag, SourceSiteContentTag, SourceSitePricing } from '../contracts/definition';
import { definitions } from './definitions';

/** Each adapter owns zero or more directory entries; the UI has no site-specific branches. */
export function listSupportedSites(registry: readonly SourceDefinition[] = definitions) {
  return registry.filter(adapter => adapter.capabilities.importable).flatMap(adapter =>
    (adapter.sites ?? []).map(site => ({ ...site, adapterId: adapter.id, key: `${adapter.id}:${site.id}` })),
  ).sort((a, b) => b.adaptedOn.localeCompare(a.adaptedOn));
}

export interface SiteFilters {
  content: readonly SourceSiteContentTag[];
  pricing: readonly SourceSitePricing[];
  raw: readonly boolean[];
  access: readonly SourceSiteAccessTag[];
}

/** OR within a group, AND across groups; empty groups do not restrict results. */
export function matchesSiteFilters(site: SourceSite, filters: SiteFilters) {
  return (!filters.content.length || filters.content.some(tag => site.contentTags.includes(tag)))
    && (!filters.pricing.length || filters.pricing.includes(site.pricing))
    && (!filters.raw.length || filters.raw.includes(site.isRaw))
    && (!filters.access.length || filters.access.some(tag => site.accessTags?.includes(tag)));
}
