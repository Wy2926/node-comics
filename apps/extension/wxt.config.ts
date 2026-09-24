import { defineConfig } from 'wxt';
import { importAssets } from './import-assets';
import { sourceInstallation } from './source-installation';
import { writeStoreLocales } from './store-locales';
import { unrarCsp } from './unrar-csp';
writeStoreLocales();
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite:()=>({plugins:[importAssets(),unrarCsp()],optimizeDeps:{exclude:['node-unrar-js']},worker:{format:'es',plugins:()=>[unrarCsp()]}}),
  // WXT loads .env files after importing this config; resolve permissions afterwards.
  manifest: ({browser}) => ({
    ...(browser === 'chrome' && process.env.VITE_GOOGLE_CHROME_CLIENT_ID ? {oauth2: {
      client_id: process.env.VITE_GOOGLE_CHROME_CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    }} : {}),
    browser_specific_settings: {
      gecko: {
        id: 'comics@nodelane.net',
        strict_min_version: '140.0',
        // Account sign-in/profile and user-selected images sent for translation.
        data_collection_permissions: {
          required: ['authenticationInfo', 'personallyIdentifyingInfo', 'websiteContent'],
        },
      },
      gecko_android: { strict_min_version: '142.0' },
    },
    // Chrome Web Store public key: keeps unpacked builds on the store item's ID.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArcK9rWRp4mvqZn4F4bn6yAB2QZJxq9GqjnziRbP/TUOgxO/ieQeya6Q+ul6Oa84ww4P9hxXUYcMMRHnebQRfpV4d7Fuhmp5rToRjc9y0raaphioLbuUOIIY6hXBDfdL9yFxJsLhlleRvaFhUEh1ilNpEPzXrIF5kYgo94HbCZQKpiy/9tSgXpXT0a61d+rWa5ZJbDROnVOB+463qU8i3Cjs5gxakLrdtmILpzU4bglO8klexaNnHT0fa+U6MgBnu/XXhdyWC2t1ZLgjIkkCMDC3EKdI4RR4CH2E/2St2PFWGzdpdH+kxjbczGJAsHjMZsqSS0h5sFFK/mGCBK4qowwIDAQAB',
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
