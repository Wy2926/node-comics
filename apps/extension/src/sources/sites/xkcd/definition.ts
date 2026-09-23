import type { SourceDefinition } from '../../contracts/definition';
export const definition: SourceDefinition = {
  id: 'xkcd',
  name: 'xkcd',
  sites: [{ id: 'xkcd', name: 'xkcd', url: 'https://xkcd.com/', icon: '/site-icons/xkcd.svg' }],
  capabilities: { importable: true, pages: true, inline: true, catalog: false, completePageList: true },
  installation: { requiredOrigins: [], autoContentMatches: [] },
  identify(url) {
    return ['xkcd.com', 'www.xkcd.com'].includes(url.hostname)
      ? {
          sourceId: this.id,
          pageKey: this.id + ':' + url.href,
          kind: /^\/(?:\d+\/?)?$/.test(url.pathname) ? 'reader' : 'other',
          url: url.href,
        }
      : null;
  },
};
