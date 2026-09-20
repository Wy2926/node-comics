import { defineConfig } from 'wxt';
import {importAssets} from './import-assets';
import {unrarCsp} from './unrar-csp';
import {MANGACOPY_PERMISSIONS} from './src/sources/mangacopy';
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite:()=>({plugins:[importAssets(),unrarCsp()],optimizeDeps:{exclude:['node-unrar-js']},worker:{format:'es',plugins:()=>[unrarCsp()]}}),
  manifest: {
    // Chrome Web Store public key: keeps unpacked builds on the store item's ID.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArcK9rWRp4mvqZn4F4bn6yAB2QZJxq9GqjnziRbP/TUOgxO/ieQeya6Q+ul6Oa84ww4P9hxXUYcMMRHnebQRfpV4d7Fuhmp5rToRjc9y0raaphioLbuUOIIY6hXBDfdL9yFxJsLhlleRvaFhUEh1ilNpEPzXrIF5kYgo94HbCZQKpiy/9tSgXpXT0a61d+rWa5ZJbDROnVOB+463qU8i3Cjs5gxakLrdtmILpzU4bglO8klexaNnHT0fa+U6MgBnu/XXhdyWC2t1ZLgjIkkCMDC3EKdI4RR4CH2E/2St2PFWGzdpdH+kxjbczGJAsHjMZsqSS0h5sFFK/mGCBK4qowwIDAQAB',
    name: 'Node Comics · 漫游', description: '让故事跨越语言。轻量漫画翻译与沉浸阅读器。',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'identity'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    host_permissions: ['https://*.nodelane.net/*',...MANGACOPY_PERMISSIONS],
    action: { default_title: 'Node Comics · 漫游' },
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  },
});
