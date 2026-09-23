import type { SourceNetwork } from '../contracts/network';
const sites = import.meta.glob<SourceNetwork>('../sites/*/network.ts', { eager: true, import: 'network' });
export const sourceNetworks: Readonly<Record<string, SourceNetwork>> = Object.fromEntries(Object.entries(sites).map(([path, network]) => [path.split('/').at(-2)!, network]));
