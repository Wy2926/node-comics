import type { CreateSourcePage } from '../contracts/page';
import { createPage as generic } from '../generic/page';
import { definitions } from './definitions';
const sites = import.meta.glob<CreateSourcePage>('../sites/*/page.ts', { eager: true, import: 'createPage' });
const factories = Object.fromEntries(Object.entries(sites).map(([path, factory]) => [path.split('/').at(-2)!, factory]));
for (const definition of definitions.filter(source => source.inlineRecognition === 'generic')) {
  if (factories[definition.id] || !definition.capabilities.inline) throw Error('SOURCE_CAPABILITY_MISMATCH');
  factories[definition.id] = context => ({...generic(context),
    discoverPages: async () => ({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'}),
  });
}
export const pageFactories: Readonly<Record<string, CreateSourcePage>> = {generic, ...factories};
