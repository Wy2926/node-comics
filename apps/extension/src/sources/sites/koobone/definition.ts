import type {SourceDefinition} from '../../contracts/definition';
import installation from './installation.json';

export const origin = 'https://koobone.com';
export const definition: SourceDefinition = {
  id: 'koobone', name: 'KOOBONE', installation,
  capabilities: {importable: false, pages: false, inline: true, catalog: false, completePageList: false, findAlternatives: false},
  identify(url) {
    if (url.origin !== origin || url.username || url.password || url.pathname !== '/web.htm') return null;
    return {sourceId: this.id, pageKey: 'koobone:' + url.href, kind: 'reader', url: url.href};
  },
};
