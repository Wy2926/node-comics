import type {SourceDefinition} from '../../contracts/definition';
import {gigaViewerIdentity} from '../../shared/gigaviewer/identity';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const identity = gigaViewerIdentity('zenon', 'https://comic-zenon.com');
export const definition: SourceDefinition = {
  id: identity.sourceId, name: 'ゼノンプラス', installation,
  sites: [{id: identity.sourceId, name: 'ゼノンプラス', url: identity.origin + '/', icon,
    adaptedOn: '2026-10-23', pricing: 'freemium', isRaw: true, isAdult: false, accessTags: ['login-required'],
    contentTags: ['manga'], primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}, identify: identity.identify,
};
