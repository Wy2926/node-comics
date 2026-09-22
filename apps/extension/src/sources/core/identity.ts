import type { SourceDefinition } from '../contracts/definition';
import { resolveSource } from './resolve';
export function sameSource(a: string, b: string, definitions: readonly SourceDefinition[]) {
  try {
    const x = resolveSource(a, definitions).location,
      y = resolveSource(b, definitions).location;
    return x.sourceId === y.sourceId && x.pageKey === y.pageKey && x.kind === y.kind;
  } catch {
    return false;
  }
}
