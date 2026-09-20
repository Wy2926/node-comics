import { defineConfig } from 'wxt';
import {importAssets} from './import-assets';
import {unrarCsp} from './unrar-csp';
import {MANGACOPY_PERMISSIONS} from './src/sources/mangacopy';
import {writeStoreLocales} from './store-locales';
writeStoreLocales();
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite:()=>({plugins:[importAssets(),unrarCsp()],optimizeDeps:{exclude:['node-unrar-js']},worker:{format:'es',plugins:()=>[unrarCsp()]}}),
  manifest: {
    // Chrome Web Store public key: keeps unpacked builds on the store item's ID.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArcK9rWRp4mvqZn4F4bn6yAB2QZJxq9GqjnziRbP/TUOgxO/ieQeya6Q+ul6Oa84ww4P9hxXUYcMMRHnebQRfpV4d7Fuhmp5rToRjc9y0raaphioLbuUOIIY6hXBDfdL9yFxJsLhlleRvaFhUEh1ilNpEPzXrIF5kYgo94HbCZQKpiy/9tSgXpXT0a61d+rWa5ZJbDROnVOB+463qU8i3Cjs5gxakLrdtmILpzU4bglO8klexaNnHT0fa+U6MgBnu/XXhdyWC2t1ZLgjIkkCMDC3EKdI4RR4CH2E/2St2PFWGzdpdH+kxjbczGJAsHjMZsqSS0h5sFFK/mGCBK4qowwIDAQAB',
    name: '__MSG_extensionName__', description: '__MSG_extensionDescription__',
    default_locale: 'en', short_name: 'NodeLane', homepage_url: 'https://comics.nodelane.net/',
    icons: {16:'brand/icon-16.png',32:'brand/icon-32.png',48:'brand/icon-48.png',128:'brand/icon-128.png'},
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'identity'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    host_permissions: ['https://*.nodelane.net/*',...MANGACOPY_PERMISSIONS],
    action: { default_title: '__MSG_actionTitle__', default_icon: {16:'brand/icon-16.png',24:'brand/icon-24.png',32:'brand/icon-32.png'} },
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  },
});
