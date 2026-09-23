import type { SourceDefinition } from '../../contracts/definition';
export const definition: SourceDefinition = {
  id: 'comicpash',
  name: 'Comic PASH!',
  capabilities: { importable: true, pages: true, inline: true, catalog: false, completePageList: false },
  installation: { requiredOrigins: [], autoContentMatches: [] },
  identify(url) {
    return ['comicpash.jp', 'www.comicpash.jp'].includes(url.hostname) &&
      /^\/episodes\/[a-zA-Z0-9]+\/?$/.test(url.pathname)
      ? {
          sourceId: this.id,
          pageKey: this.id + ':' + url.pathname.replace(/\/$/, ''),
          kind: 'reader',
          url: url.href,
        }
      : null;
  },
};
