# NodeLane 官网

Astro + React + TypeScript。公开页面输出静态 HTML，首页选图、图片翻译工作台和账户使用 React 岛，与后端共用域名和 API。首页选图后进入 `/translate/`，支持原图／译图／对照、下载完整译图和浏览器本地历史。

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

打开 `http://127.0.0.1:4322/`；身份、订阅与支付均为模拟。正式构建使用 `backend/Dockerfile.static` 的 `website` 目标，OpenResty 独立提供静态产物；发布不重建或重启 API，步骤见[部署规范](../../docs/DEPLOYMENT.md)。

## 内容与规范

图片翻译浏览器验收：构建后在仓库根目录运行 `backend/.venv/Scripts/python.exe backend/tests/manual_website_translation_server.py`，打开 `http://127.0.0.1:4322/`；可用 `--port` 指定独立端口，避免与账户夹具冲突。服务生成 `artifacts/website-translation/` 合成图片，提供模拟身份、人机验证、普通覆盖和 WebP 分块结果。`POST /__state` 可设置 `tiles_enabled`、`max_dimension`、`fail_create_response_once`、`events_truncate_once`、`events_reconnect_once`、`result_failure_once`，以及 `widget_delay_ms`、`events_delay_ms`、`result_delay_ms`（0–30000 毫秒）；`reset: true` 清空模拟任务和计数。`GET /__state` 返回每个 UUID 的创建、上传、查询、下载与 SSE 计数，用于核实恢复不会重复提交。自动分块验收见[脚本入口](../../scripts/README.md#官网验收)，不会访问真实 Cloudflare、数据库或模型。正式匿名体验配置见[部署规范](../../docs/DEPLOYMENT.md#官网匿名图片体验)。

- 图片工作台只接收 JPG、PNG、WebP，不导入漫画容器、远程网址或书架。送译缩放、编码、摘要和普通／分块结果的完整图合成复用 [shared/translation-images](../shared/translation-images)。像素处理按需启动单 Worker，跨标签页使用 Web Locks 串行；首页不加载像素处理模块或验证脚本。尺寸、能力协商与冻结恢复规则见[翻译契约](../../docs/READING_TRANSLATION_CONTRACT.md#官网图片工作台)。
- 登录使用原账户额度，匿名身份与额度独立，规则见[会员额度](../../docs/MEMBERSHIP_AND_QUOTAS.md#官网匿名体验)。历史按账户／游客隔离，不在登录时自动合并；本地与服务器期限见[存储规范](../../docs/OBJECT_STORAGE.md#官网本地历史与游客结果)。工作台不索引、禁止共享缓存。

- [src/i18n](src/i18n)：简中、繁中、英、日、韩、法、西、巴西葡萄牙、德、意、俄、波兰、乌克兰、土耳其、越南、印尼语独立字典；新增页面或文案同步 16 语。语言由 URL 决定，切换保留当前页面；[语言偏好方案](../../docs/WEBSITE_LANGUAGE_DESIGN.md)说明浏览器语言提示、手动偏好和匹配规则。
- [本地翻译内容](src/i18n/guides)：连接 manga-translator-ui 的操作教程与本地漫画翻译介绍；[主字典](src/i18n)维护本地格式、EPUB、Google Drive／OPDS、网页图片与选区翻译指南。插件仅提供常规图片翻译，官网工作台模式按实际能力与账户权益显示；EPUB 只翻译内嵌位图，OPDS 进度仅在来源支持时同步。指南由列表、帮助、FAQ 和相关文章进入，正文支持步骤、命令、对照表及来源链接。
- 卸载反馈页 `/uninstall/` 提供16 语可选问卷，通过同源匿名反馈 API 保存。原因、幂等重试与上线顺序见[反馈规范](../../docs/ADMIN_CONSOLE.md#匿名网站申请插件与卸载反馈)。
- [src/data/site.ts](src/data/site.ts)：域名、邮件与商店地址；[extension-release.json](../extension-release.json)：安装包目录。发布版本和下载签名由后端管理。
- [src/data/published-lite.ts](src/data/published-lite.ts)：官网静态公布的 Lite 价格与权益；购买状态和正式结账报价来自账单 API。更新规则见[支付规则](../../docs/STRIPE_BILLING.md#已确认的产品规则)。
- [public/design-tokens.css](public/design-tokens.css) 是官网唯一的基础视觉令牌来源，也供 Drive 连接页复用；[src/styles/controls.css](src/styles/controls.css) 统一全站按钮、选择器及其交互状态，页面 CSS 只安排控件布局。[ComicSymbol.astro](src/components/ComicSymbol.astro) 提供原创静态 SVG。图片来源见 [ASSETS.md](ASSETS.md)，依赖与许可见 [DEPENDENCIES.md](DEPENDENCIES.md)。升级依赖后执行 `npm run notices`。
- 每页维护标题、正文、canonical、hreflang 和结构化数据；页面关键词分工、16 语用词与 FAQ 规则见 [SEO 规范](SEO.md)。账户、身份回调、支付返回与卸载反馈页不索引。构建检查站内链接、锚点、商店入口及 FAQ 正文与 SEO 数据一致性。
- 账户使用同源 OIDC + PKCE，精确回调为 `/auth/callback/`；前端不存 client secret。会话限当前标签页，写请求不自动重放，支付返回页不发放权益。见[身份规范](../../docs/PRODUCTION_IDENTITY.md)和[支付规则](../../docs/STRIPE_BILLING.md)。

浏览器检查入口见[脚本说明](../../scripts/README.md#官网验收)，覆盖16 语、加载与失败、图片切换、登录返回和订阅交互。
