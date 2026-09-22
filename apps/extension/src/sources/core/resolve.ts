import type { SourceDefinition } from '../contracts/definition';
import { safeImageUrl } from '../shared/urls';
export function resolveSource(url: string, definitions: readonly SourceDefinition[]) {
  const safe = safeImageUrl(url, url);
  if (!safe) throw Error('INVALID_SOURCE_URL');
  if (new Set(definitions.map((d) => d.id)).size !== definitions.length)
    throw Error('SOURCE_REGISTRY_CONFLICT');
  const parsed = new URL(safe),
    matches = definitions
      .filter((d) => d.id !== 'generic')
      .flatMap((definition) => {
        const location = definition.identify(parsed);
        return location ? [{ definition, location }] : [];
      });
  if (matches.length > 1) throw Error('SOURCE_REGISTRY_CONFLICT');
  if (matches.length) return matches[0];
  const definition = definitions.find((d) => d.id === 'generic'),
    location = definition?.identify(parsed);
  if (!definition || !location) throw Error('SOURCE_UNSUPPORTED');
  return { definition, location };
}
