import { defineConfig } from 'wxt';
import { importAssets } from './import-assets';
import { sourceInstallation } from './source-installation';
import { writeStoreLocales } from './store-locales';
import { unrarCsp } from './unrar-csp';
import { extensionIdentity } from './extension-identity';
writeStoreLocales();
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite:()=>({plugins:[importAssets(),unrarCsp()],optimizeDeps:{exclude:['node-unrar-js']},worker:{format:'es',plugins:()=>[unrarCsp()]}}),
  // WXT loads .env files after importing this config; resolve permissions afterwards.
  manifest: ({browser}) => ({
    ...(browser === 'firefox' ? {browser_specific_settings: {
      gecko: {
        id: 'comics@nodelane.net',
        strict_min_version: '140.0',
        // Account sign-in/profile and user-selected images sent for translation.
        data_collection_permissions: {
          required: ['authenticationInfo', 'personallyIdentifyingInfo', 'websiteContent'],
        },
      },
      gecko_android: { strict_min_version: '142.0' },
    }} : {}),
    ...extensionIdentity(browser, process.env.NC_EXTENSION_PACKAGE === 'store'),
    name: '__MSG_extensionName__', description: '__MSG_extensionDescription__',
    default_locale: 'en', short_name: 'NodeLane', homepage_url: 'https://comics.nodelane.net/',
    icons: {16:'brand/icon-16.png',32:'brand/icon-32.png',48:'brand/icon-48.png',128:'brand/icon-128.png'},
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'identity', 'alarms', 'declarativeNetRequestWithHostAccess', 'webRequest'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    host_permissions: ['https://*.nodelane.net/*',...sourceInstallation.requiredOrigins,
      ...(process.env.VITE_DRIVE_CONNECT_URL ? ['https://www.googleapis.com/*', new URL(process.env.VITE_DRIVE_CONNECT_URL).origin+'/*'] : []),
      ...(process.env.VITE_API_BASE ? [new URL(process.env.VITE_API_BASE).origin+'/*'] : [])],
    action: { default_title: '__MSG_actionTitle__', default_icon: {16:'brand/icon-16.png',24:'brand/icon-24.png',32:'brand/icon-32.png'} },
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  }),
});
