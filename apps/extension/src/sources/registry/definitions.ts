import type { SourceDefinition } from '../contracts/definition';
import { definition as generic } from '../generic/definition';
const sites = import.meta.glob<SourceDefinition>('../sites/*/definition.ts', { eager: true, import: 'definition' });
export const definitions: readonly SourceDefinition[] = [generic, ...Object.values(sites)];
