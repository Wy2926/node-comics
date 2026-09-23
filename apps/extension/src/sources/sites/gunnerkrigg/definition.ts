import installation from './installation.json';
import type { SourceDefinition } from '../../contracts/definition';
export const definition: SourceDefinition = {
  id: 'gunnerkrigg',
  name: 'Gunnerkrigg',
  sites: [{ id: 'gunnerkrigg', name: 'Gunnerkrigg', url: 'https://www.gunnerkrigg.com/', icon: '/site-icons/gunnerkrigg.svg' }],
  capabilities: { importable: true, pages: true, inline: true, catalog: false, completePageList: true },
  installation,
  identify(url) {
    return ['gunnerkrigg.com', 'www.gunnerkrigg.com'].includes(url.hostname)
      ? {
          sourceId: this.id,
          pageKey: this.id + ':' + url.href,
          kind: url.pathname === '/' || url.pathname === '/index.php' ? 'reader' : 'other',
          url: url.href,
        }
      : null;
  },
};
