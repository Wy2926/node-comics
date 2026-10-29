// Build-time only: share the extension's ordering, importability and site labels.
import { listSupportedSites } from '../../../../apps/extension/src/sources/registry/sites';

const packagedIcons = import.meta.glob<string>('../../../../apps/extension/public/site-icons/*.svg', {
  eager: true, query: '?url', import: 'default',
});

export const supportedSites = listSupportedSites().map(site => {
  const icon = site.icon.startsWith('/site-icons/')
    ? packagedIcons[`../../../../apps/extension/public${site.icon}`] : site.icon;
  if (!icon) throw new Error(`Missing packaged site icon: ${site.key}`);
  return { ...site, icon, anchor: `site-${site.adapterId}-${site.id}` };
});
