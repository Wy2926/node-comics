import { msg } from '../i18n/runtime';
import type { SourceDefinition } from './contracts/definition';
import { validateCatalog } from './core/catalog';
import { sameSource } from './core/identity';
import { resolveSource } from './core/resolve';
import { definitions } from './registry/definitions';
export type * from './contracts/definition';
export type * from './contracts/source';
export { pollSourceDiscovery } from './core/discovery';
export { discoverCatalog, discoverEntry, discoverPage, inExtension, sourceMessage } from './runtime/client';
export { sourceImage } from './runtime/image-fetch';
export {
  copyOrigins,
  imageOrigins,
  ImagePermissionsRequired,
  requestImagePermissions,
  requireImagePermissions,
} from './runtime/permissions';
export { imageDataUrl, maxInlineBytes } from './shared/bytes';
export { comicSize } from './shared/dimensions';
export { isPageImageUrl, safeImageUrl } from './shared/urls';
export function createSourceService(registry: readonly SourceDefinition[]) {
  return {
    resolve: (url: string) => resolveSource(url, registry),
    validateCatalog: (input: unknown) => validateCatalog(input, registry),
    samePage: (a: string, b: string) => sameSource(a, b, registry),
  };
}
const service = createSourceService(definitions);
export const sourceFor = service.resolve;
export const sourceLocation = (url: string) => {
  try {
    return sourceFor(url).location;
  } catch {
    return null;
  }
};
export const sourcePageIdentity = (url: string) => sourceLocation(url)?.pageKey ?? url;
export const sourceCatalogReference = (url: string) => sourceLocation(url)?.catalog;
export const sameSourcePage = service.samePage;
export const sourceName = (id: string) => definitions.find((d) => d.id === id)?.name || msg('网页图片');
export const sourceInstallation = {
  requiredOrigins: [...new Set(definitions.flatMap((d) => d.installation.requiredOrigins))],
  autoContentMatches: [...new Set(definitions.flatMap((d) => d.installation.autoContentMatches))],
};
export const validateSourceCatalog = service.validateCatalog;
