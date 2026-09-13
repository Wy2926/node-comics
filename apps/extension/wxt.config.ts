import { defineConfig } from 'wxt';
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Node Comics · 漫游', description: '让故事跨越语言。轻量漫画翻译与沉浸阅读器。',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'identity'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    host_permissions: ['http://127.0.0.1:18088/*', 'http://localhost:18088/*'],
    action: { default_title: 'Node Comics · 漫游' },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
  },
});
