import type { SourceDefinition } from '../contracts/definition';
import { definitions } from './definitions';

/** Each adapter owns zero or more directory entries; the UI has no site-specific branches. */
export function listSupportedSites(registry: readonly SourceDefinition[] = definitions) {
  return registry.filter(adapter => adapter.capabilities.importable).flatMap(adapter =>
    (adapter.sites ?? []).map(site => ({ ...site, adapterId: adapter.id, key: `${adapter.id}:${site.id}` })),
  );
}
