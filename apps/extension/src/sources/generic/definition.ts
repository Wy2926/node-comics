import type { SourceDefinition } from '../contracts/definition';
export const definition: SourceDefinition = {
  id: 'generic',
  name: '',
  capabilities: { pages: true, inline: true, catalog: false, completePageList: false },
  installation: { requiredOrigins: [], autoContentMatches: [] },
  identify: (url) => ({ sourceId: 'generic', pageKey: url.href, kind: 'reader', url: url.href }),
};
