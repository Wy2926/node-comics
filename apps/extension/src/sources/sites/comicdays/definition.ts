import type {SourceDefinition} from '../../contracts/definition';
import {gigaViewerIdentity} from '../../shared/gigaviewer/identity';
import installation from './installation.json';
import icon from './icon.svg?inline';

export const identity = gigaViewerIdentity('comicdays', 'https://comic-days.com', 'nodelane-days');
export const {origin, seriesKey, catalogUrl, episodeUrl} = identity;
export const definition: SourceDefinition = {
  id: identity.sourceId, name: 'Comic DAYS', installation,
  sites: [{id: identity.sourceId, name: 'Comic DAYS', url: origin + '/', icon,
    adaptedOn: '2026-10-03', pricing: 'freemium', isRaw: true, isAdult: false, accessTags: ['login-required'], contentTags: ['manga'], primaryLanguages: ['ja'], search: true}],
  capabilities: {importable: true, pages: true, inline: true, catalog: true, completePageList: true},
  embeddedEntry: 'floating', catalogSync: {intervalMinutes: 720}, identify: identity.identify,
};
