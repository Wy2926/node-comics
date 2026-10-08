# NodeLane 官网

Astro + React + TypeScript。公开页面输出静态 HTML，图片翻译工作台和账户使用 React 岛，与后端共用域名和 API。首页以漫画翻译浏览器插件为主入口，用深色左右分栏、单一主安装按钮、真实阅读对照与 Free／Lite 突出产品重点；完整功能、FAQ 与条款留在独立页面。网页图片翻译由首屏和页脚次级链接进入 `/translate/`，流程为批量上传（每次最多 10 张）、选择目标语言、翻译、下载。文件列表显示进度、失败重试与恢复；支持逐张下载及将当前列表已完成译图打包为 ZIP，不提供预览、缩放或原译对照。本地记录按账户隔离，存储说明折叠展示。ZIP 库按需加载，逐张读取结果并直接打包，不重复压缩图片。

## 运行

翻译页支持文件选择、拖放和页面内图片粘贴；不拦截输入框中的文字粘贴。“清空本地缓存”确认后一次性移除当前历史列表的原图、送译副本、译图和记录，不影响其他账户、登录或服务器任务；导入、翻译同步和下载期间禁用。语言菜单支持内部 Tab 导航，焦点离开、点击外部或 Esc 时收起。

定价页“开通”直接使用当前 API 报价发起托管结账；未登录时保留语言与报价，登录后一次性继续。已有订阅／赠送或不同的待处理报价转到账户管理，不自动更换报价。`tests/checkout-fixture.html` 使用账户隔离夹具（Vite 配置 `tests/account-fixture.config.ts`，端口 5193）检查按钮与模拟登录，不创建真实订单。

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

### 页面内容

- 不提供独立广告落地页，统一使用对应语言的首页。品牌使用真实的 NodeLane Comics 团队身份，不宣称注册公司。
- 隐私政策、FAQ 和指南中的扩展权限说明以 [WXT 配置](../../apps/extension/wxt.config.ts)和[公共权限规则](../../docs/SITE_ADAPTERS.md#必须保持的约束)为准，修改时同步全部语言；不要将安装时声明的网站访问权限与账号登录、OAuth 或可选统计授权混为一谈。
- 获取插件按钮使用 `data-install-extension`：通过本机浏览器信息识别桌面 Chrome、Edge、Firefox，点击直达对应官方商店；Android 和 iPhone／iPad 进入当前语言的 Firefox／Orion 教程，未知浏览器或禁用 JavaScript 时保留下载选择页。商店地址以 [src/data/site.ts](src/data/site.ts) 为唯一来源，不上传浏览器信息。
- 手机入口为 `/guides/android-firefox/` 与 `/guides/ios-orion/`，不是独立 App 下载；首页 PC 浏览器在上一行，Android／iOS 在下一行，下载页、帮助页和指南目录均可进入。17 语正文维护在 [src/i18n/mobile.ts](src/i18n/mobile.ts)，官方链接维护在 [src/data/mobile.ts](src/data/mobile.ts)。iOS／Orion 当前标为“适配中”，未正式支持，不提供已完成的安装步骤或截图。Android 三个截图槽位使用 [public/guides/firefox](public/guides/firefox) 中的真实模拟器截图：简繁中文共用 zh-CN，其余语言使用 en，保留本地化图注、1080×2400 比例和懒加载。截图不证明永久安装、登录或翻译全流程；来源和摘要见 [ASSETS.md](ASSETS.md)。

图片翻译浏览器验收：构建后在仓库根目录运行 `backend/.venv/Scripts/python.exe backend/tests/manual_website_translation_server.py`，打开 `http://127.0.0.1:4322/`；可用 `--port` 指定独立端口，避免与账户夹具冲突。服务生成 `artifacts/website-translation/` 合成图片，提供模拟身份、人机验证、普通覆盖和 WebP 分块结果。`POST /__state` 可设置 `tiles_enabled`、`max_dimension`、`fail_create_response_once`、`events_truncate_once`、`events_reconnect_once`、`result_failure_once`，以及 `widget_delay_ms`、`events_delay_ms`、`result_delay_ms`（0–30000 毫秒）；`reset: true` 清空模拟任务和计数。`GET /__state` 返回每个 UUID 的创建、上传、查询、下载与 SSE 计数，用于核实恢复不会重复提交。自动分块验收见[脚本入口](../../scripts/README.md#官网验收)，不会访问真实 Cloudflare、数据库或模型。正式匿名体验配置见[部署规范](../../docs/DEPLOYMENT.md#官网匿名图片体验)。

- 图片工作台只接收 JPG、PNG、WebP，不导入漫画容器、远程网址或书架。送译缩放、编码、摘要和普通／分块结果的完整图合成复用 [shared/translation-images](../shared/translation-images)。像素处理按需启动单 Worker，跨标签页使用 Web Locks 串行；首页不加载像素处理模块或验证脚本。尺寸、能力协商与冻结恢复规则见[翻译契约](../../docs/READING_TRANSLATION_CONTRACT.md#官网图片工作台)。
- 登录使用原账户额度，匿名身份与额度独立，规则见[会员额度](../../docs/MEMBERSHIP_AND_QUOTAS.md#官网匿名体验)。历史按账户／游客隔离，不在登录时自动合并；本地与服务器期限见[存储规范](../../docs/OBJECT_STORAGE.md#官网本地历史与游客结果)。工作台不索引、禁止共享缓存。

- [src/i18n](src/i18n)：简中、繁中、英、日、韩、法、西、巴西葡萄牙、德、意、俄、波兰、乌克兰、土耳其、越南、印尼、阿拉伯语独立字典；常规公开页面或文案同步 17 语。语言由 URL 决定，切换保留当前页面；[语言偏好方案](../../docs/WEBSITE_LANGUAGE_DESIGN.md)说明浏览器语言提示、手动偏好和匹配规则。
- [本地翻译内容](src/i18n/guides)：连接 manga-translator-ui 的操作教程与本地漫画翻译介绍；[主字典](src/i18n)维护本地格式、EPUB、Google Drive／OPDS、网页图片与选区翻译指南。插件与官网工作台均提供常规图片翻译；官网不提供其他模式的新任务入口，已有本地结果仍可读取、下载和恢复查询。EPUB 只翻译内嵌位图，OPDS 进度仅在来源支持时同步。指南由列表、帮助、FAQ 和相关文章进入，正文支持步骤、命令、对照表及来源链接。
- 卸载反馈页 `/uninstall/` 提供17 语可选问卷，通过同源匿名反馈 API 保存。原因、幂等重试与上线顺序见[反馈规范](../../docs/ADMIN_CONSOLE.md#匿名网站申请插件与卸载反馈)。
- [src/data/site.ts](src/data/site.ts)：域名、邮件与商店地址；[extension-release.json](../extension-release.json)：安装包目录。发布版本和下载签名由后端管理。
- [src/data/published-lite.ts](src/data/published-lite.ts)：官网静态公布的 Lite 价格与权益；首页静态预览与价格页共用月／年选择，醒目价格为对应周期的实付总额，币种缩小显示，年付另外标注月均价。年付优惠在周期选择下方保留固定空间，按同币种、同权益版本的月价对比计算；缺少可比报价时不展示折扣。首页突出无日／月累计上限、受理速率、模型和优先响应；对比页共同权益双方勾选，差异权益仅 Lite 勾选并加重文字。购买状态和正式结账报价来自账单 API，缺少当前周期报价时不自动跳到另一周期，也不生成购买链接；禁用 JavaScript 时保留月价和年总价。更新规则见[支付规则](../../docs/STRIPE_BILLING.md#已确认的产品规则)。
- [public/design-tokens.css](public/design-tokens.css) 维护基础视觉令牌，也供 Drive 连接页复用；[src/styles/marketing.css](src/styles/marketing.css) 为官网布局提供统一深色覆盖，不改变 Drive 令牌；[src/styles/controls.css](src/styles/controls.css) 统一全站按钮、选择器及其交互状态，页面 CSS 只安排控件布局。[ComicSymbol.astro](src/components/ComicSymbol.astro) 提供原创静态 SVG。图片来源见 [ASSETS.md](ASSETS.md)，依赖与许可见 [DEPENDENCIES.md](DEPENDENCIES.md)。升级依赖后执行 `npm run notices`。
- 每页维护标题、正文、canonical、hreflang 和结构化数据；页面关键词分工、17 语用词与 FAQ 规则见 [SEO 规范](SEO.md)。账户、身份回调、支付返回与卸载反馈页不索引。构建检查站内链接、锚点、商店入口及 FAQ 正文与 SEO 数据一致性。
- 账户使用同源 OIDC + PKCE，精确回调为 `/auth/callback/`；前端不存 client secret。会话限当前标签页，写请求不自动重放，支付返回页不发放权益。见[身份规范](../../docs/PRODUCTION_IDENTITY.md)和[支付规则](../../docs/STRIPE_BILLING.md)。

浏览器检查入口见[脚本说明](../../scripts/README.md#官网验收)，覆盖17 语、加载与失败、图片切换、登录返回和订阅交互。
