import type {WorkProvider} from './types';

const modules = import.meta.glob<WorkProvider>('./providers/*.ts', {eager: true, import: 'provider'});
export const workProviders: readonly WorkProvider[] = Object.values(modules);
if (new Set(workProviders.map(provider => provider.id)).size !== workProviders.length) throw Error('Duplicate work provider');
