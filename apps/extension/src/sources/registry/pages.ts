import type { CreateSourcePage, DescribeSourceWork } from '../contracts/page';
import { createPage as generic } from '../generic/page';
import { definitions } from './definitions';
const sites = import.meta.glob<{createPage?: CreateSourcePage; describeWork?: DescribeSourceWork}>('../sites/*/page.ts', { eager: true });
const modules = Object.fromEntries(Object.entries(sites).map(([path, module]) => [path.split('/').at(-2)!, module]));
const factories: Record<string, CreateSourcePage> = Object.fromEntries(Object.entries(modules)
  .flatMap(([id, module]) => module.createPage ? [[id, module.createPage]] : []));
for (const definition of definitions.filter(source => source.inlineRecognition === 'generic')) {
  if (factories[definition.id] || !definition.capabilities.inline) throw Error('SOURCE_CAPABILITY_MISMATCH');
  const describeWork = modules[definition.id]?.describeWork;
  factories[definition.id] = context => {
    const session = generic(context);
    let disposed = false;
    return {...session,
      discoverPages: async () => ({status: 'unsupported', code: 'SOURCE_PAGE_UNSUPPORTED'}),
      ...(describeWork ? {describeWork: () => {
        context.signal.throwIfAborted();
        if (disposed) throw Error('SOURCE_SESSION_EXPIRED');
        return describeWork(context);
      }} : {}),
      dispose() {disposed = true; session.dispose();},
    };
  };
}
export const pageFactories: Readonly<Record<string, CreateSourcePage>> = {generic, ...factories};
