# NodeLane 官网

Astro + React + TypeScript。公开页面输出静态 HTML，账户与图片对照使用 React 岛，与后端共用域名和 API。

## 运行

需要 Node.js 22.12+，在本目录执行：

```powershell
npm ci
npm run dev          # http://127.0.0.1:4321
npm test
npm run build
npm run preview
```

`dev` / `preview` 用于公开页面。完整账户流程先构建，再从仓库根目录启动隔离服务：

```powershell
uv run --with-requirements backend/requirements.txt python backend/tests/manual_website_server.py
```

打开 `http://127.0.0.1:4322/`；身份、订阅与支付均为模拟。正式构建由后端 Docker 集成，发布步骤见[部署规范](../../docs/DEPLOYMENT.md)。

## 内容与规范

- [src/i18n](src/i18n)：简中、繁中、英文、日文、韩文独立字典；新增页面或文案同步五语。语言由 URL 决定，切换保留当前页面；[语言偏好方案](../../docs/WEBSITE_LANGUAGE_DESIGN.md)尚待实现。
- [src/data/site.ts](src/data/site.ts)：域名、邮件与商店地址；[extension-release.json](../extension-release.json)：安装包目录。发布版本和下载签名由后端管理。
- [public/design-tokens.css](public/design-tokens.css)：官网与 Drive 连接页共用视觉令牌。图片来源见 [ASSETS.md](ASSETS.md)，依赖与许可见 [DEPENDENCIES.md](DEPENDENCIES.md)。升级依赖后执行 `npm run notices`。
- 每页维护标题、正文、canonical、hreflang 和结构化数据；账户、身份回调与支付返回页不索引。构建自动检查站内链接和 SEO 元数据。
- 账户使用同源 OIDC + PKCE，精确回调为 `/auth/callback/`；前端不存 client secret。会话限当前标签页，写请求不自动重放，支付返回页不发放权益。见[身份规范](../../docs/PRODUCTION_IDENTITY.md)和[支付规则](../../docs/STRIPE_BILLING.md)。

浏览器检查入口见[脚本说明](../../scripts/README.md#官网验收)，覆盖五语、加载与失败、图片切换、登录返回和订阅交互。
