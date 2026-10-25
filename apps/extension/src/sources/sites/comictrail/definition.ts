import type {SourceDefinition} from '../../contracts/definition';
import {gigaViewerIdentity} from '../../shared/gigaviewer/identity';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const identity = gigaViewerIdentity('comictrail', 'https://comic-trail.com');
export const definition: SourceDefinition = {
  id: identity.sourceId, name: 'コミックトレイル', installation,
  sites: [{id: identity.sourceId, name: 'コミックトレイル', url: identity.origin + '/', icon,
    adaptedOn: '2026-10-25', pricing: 'freemium', isRaw: true,
    contentTags: ['manga'], primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}, identify: identity.identify,
};
