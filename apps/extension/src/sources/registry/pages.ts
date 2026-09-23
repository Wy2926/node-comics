import type { CreateSourcePage } from '../contracts/page';
import { createPage as generic } from '../generic/page';
const sites = import.meta.glob<CreateSourcePage>('../sites/*/page.ts', { eager: true, import: 'createPage' });
export const pageFactories: Readonly<Record<string, CreateSourcePage>> = {generic, ...Object.fromEntries(Object.entries(sites).map(([path, factory]) => [path.split('/').at(-2)!, factory]))};
