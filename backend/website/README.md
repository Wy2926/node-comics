# NodeLane 官网

Astro + React + TypeScript。公开页面输出静态 HTML，图片翻译工作台和账户使用 React 岛，与后端共用域名和 API。首页以漫画翻译浏览器插件为主入口，依次展示当前标签页翻译、黑白／彩色多语言对照、适配网站搜索和安装入口；不展示套餐，完整功能、定价、FAQ 与条款留在独立页面。网页图片翻译由顶部导航和页脚进入 `/translate/`，流程为批量上传（每次最多 10 张）、选择目标语言、翻译、下载。文件列表显示进度、失败重试与恢复；支持逐张下载及将当前列表已完成译图打包为 ZIP，不提供预览、缩放或原译对照。本地记录按账户隔离，存储说明折叠展示。ZIP 库按需加载，逐张读取结果并直接打包，不重复压缩图片。

## 运行

翻译页支持文件选择、拖放和页面内图片粘贴；不拦截输入框中的文字粘贴。“清空本地缓存”确认后一次性移除当前历史列表的原图、送译副本、译图和记录，不影响其他账户、登录或服务器任务；导入、翻译同步和下载期间禁用。语言菜单支持内部 Tab 导航，焦点离开、点击外部或 Esc 时收起。首页顶部下载按钮不可见、不可聚焦，但保留与内页相同的布局空间，切页时导航不移位；窄桌面精简品牌与账户区，1280px 及以下使用折叠菜单。

订阅与一次性额度包都只在定价页购买，插件和账户页只保留权益、订阅管理与定价入口。`tests/checkout-fixture.html` 使用账户隔离夹具（Vite 配置 `tests/account-fixture.config.ts`，端口 5193）检查购买、原请求恢复与模拟登录，不创建真实订单。额度规则见[会员与额度](../../docs/MEMBERSHIP_AND_QUOTAS.md)，独立额度订单、订阅结账与恢复规则统一维护在[支付规范](../../docs/STRIPE_BILLING.md)。

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
- 首页保留 Android、Chrome、Edge、Firefox、iOS 五个现有品牌图标，移动端图标位于浏览器两侧，窄屏自动换行。主安装按钮按浏览器显示 Chrome／Edge／Firefox 图标，其余默认 Chrome；不改变上述安装地址规则。
- 手机入口为 `/guides/android-firefox/` 与 `/guides/ios-orion/`，不是独立 App 下载；下载页、帮助页和指南目录均可进入。17 语正文维护在 [src/i18n/mobile.ts](src/i18n/mobile.ts)，官方链接维护在 [src/data/mobile.ts](src/data/mobile.ts)。iOS／Orion 当前标为“适配中”，未正式支持，不提供已完成的安装步骤或截图。Android 三个截图槽位使用 [public/guides/firefox](public/guides/firefox) 中的真实模拟器截图：简繁中文共用 zh-CN，其余语言使用 en，保留本地化图注、1080×2400 比例和懒加载。截图不证明永久安装、登录或翻译全流程；来源和摘要见 [ASSETS.md](ASSETS.md)。
- 首页不加载 React、账单模块或动画库，专用交互脚本构建预算为 gzip 4 KiB。入场效果使用 CSS 和一次性 IntersectionObserver，尊重减少动态效果设置；禁用 JavaScript 仍能看到静态图片和安装入口。标签页截图用鼠标左右移动、触控横向拖动或键盘滑杆对照，原图首次交互才下载；漫画效果在桌面并排展示，手机复用滑动对照，保留黑白／彩色和语言选择，不另设原译图按钮。图片构建为响应式 WebP，首屏优先加载，其余懒加载；只下载选中的对照版本，解码后整体切换，失败保留当前图。展示文案维护在 [src/i18n/home/showcase.ts](src/i18n/home/showcase.ts)，SEO 字典独立保留。

图片翻译浏览器验收：构建后在仓库根目录运行 `backend/.venv/Scripts/python.exe backend/tests/manual_website_translation_server.py`，打开 `http://127.0.0.1:4322/`；可用 `--port` 指定独立端口，避免与账户夹具冲突。服务生成 `artifacts/website-translation/` 合成图片，提供模拟身份、人机验证、普通覆盖和 WebP 分块结果。`POST /__state` 可设置 `tiles_enabled`、`max_dimension`、`fail_create_response_once`、`events_truncate_once`、`events_reconnect_once`、`result_failure_once`，以及 `widget_delay_ms`、`events_delay_ms`、`result_delay_ms`（0–30000 毫秒）；`reset: true` 清空模拟任务和计数。`GET /__state` 返回每个 UUID 的创建、上传、查询、下载与 SSE 计数，用于核实恢复不会重复提交。自动分块验收见[脚本入口](../../scripts/README.md#官网验收)，不会访问真实 Cloudflare、数据库或模型。正式匿名体验配置见[部署规范](../../docs/DEPLOYMENT.md#官网匿名图片体验)。

- 图片工作台只接收 JPG、PNG、WebP，不导入漫画容器、远程网址或书架。送译缩放、编码、摘要和普通／分块结果的完整图合成复用 [shared/translation-images](../shared/translation-images)。像素处理按需启动单 Worker，跨标签页使用 Web Locks 串行；首页不加载像素处理模块或验证脚本。尺寸、能力协商与冻结恢复规则见[翻译契约](../../docs/READING_TRANSLATION_CONTRACT.md#官网图片工作台)。
- 登录使用原账户额度，匿名身份与额度独立，规则见[会员额度](../../docs/MEMBERSHIP_AND_QUOTAS.md#官网匿名体验)。历史按账户／游客隔离，不在登录时自动合并；本地与服务器期限见[存储规范](../../docs/OBJECT_STORAGE.md#官网本地历史与游客结果)。工作台不索引、禁止共享缓存。

- [src/i18n](src/i18n)：简中、繁中、英、日、韩、法、西、巴西葡萄牙、德、意、俄、波兰、乌克兰、土耳其、越南、印尼、阿拉伯语独立字典；常规公开页面或文案同步 17 语。语言由 URL 决定，切换保留当前页面；[官网语言选择](../../docs/WEBSITE_LANGUAGE_DESIGN.md)定义浏览器语言提示、手动偏好和匹配规则。
- [本地翻译内容](src/i18n/guides)：连接 manga-translator-ui 的操作教程与本地漫画翻译介绍；[主字典](src/i18n)维护本地格式、EPUB、Google Drive／OPDS、网页图片与选区翻译指南。对外统一称“翻译”或“图片翻译”，官方与 MTU 只作为服务渠道区分。EPUB 只翻译内嵌位图，OPDS 进度仅在来源支持时同步。指南由列表、帮助、FAQ 和相关文章进入，正文支持步骤、命令、对照表及来源链接。
- 教程目录优先展示可独立完成的操作流程，选型、隐私、排障和兼容状态放入次级阅读区；名称搜索教程为 `/guides/find-manga/`。正文使用编号、可折叠目录、步骤、图注和原尺寸图片链接，不引入客户端框架或富文本 HTML 注入。桌面截图在 [src/assets/guides](src/assets/guides) 中维护中、日、韩、英四套：简繁中文用简中，日、韩对应各自版本，其余页面用英文；正文及图注仍为 17 语。构建生成响应式 WebP，图片懒加载且保留尺寸，页面只引用当前语言图片。截图映射及精选入口在 [guide-media.ts](src/data/guide-media.ts)，来源与验证边界见 [ASSETS.md](ASSETS.md)。
- 卸载反馈页 `/uninstall/` 提供17 语可选问卷，通过同源匿名反馈 API 保存。原因、幂等重试与上线顺序见[反馈规范](../../docs/ADMIN_CONSOLE.md#匿名网站申请插件与卸载反馈)。
- [src/data/site.ts](src/data/site.ts)：域名、邮件与商店地址；[extension-release.json](../extension-release.json)：安装包目录。发布版本和下载签名由后端管理。
- [公开套餐](../app/catalog_defaults.json) 是初始化草稿和网站展示的共同数据源；定价页显示 PLUS／Pro 的季付与年付总价、每月额度、免费／付费模型及永久额度包。新套餐无试用。实时购买仍以账单 API 的有效渠道为准，静态价格不会生成支付链接。季度和年度均按原始账期锚点逐月发放，规则见[会员额度](../../docs/MEMBERSHIP_AND_QUOTAS.md)。
- [public/design-tokens.css](public/design-tokens.css) 维护基础视觉令牌，也供 Drive 连接页复用；[src/styles/marketing.css](src/styles/marketing.css) 为官网布局提供统一深色覆盖，不改变 Drive 令牌；[src/styles/controls.css](src/styles/controls.css) 统一全站按钮、选择器及其交互状态，页面 CSS 只安排控件布局。[ComicSymbol.astro](src/components/ComicSymbol.astro) 提供原创静态 SVG。图片来源见 [ASSETS.md](ASSETS.md)，依赖与许可见 [DEPENDENCIES.md](DEPENDENCIES.md)。升级依赖后执行 `npm run notices`。
- 每页维护标题、正文、canonical、hreflang 和结构化数据；页面关键词分工、17 语用词与 FAQ 规则见 [SEO 规范](SEO.md)。账户、身份回调、支付返回与卸载反馈页不索引。构建检查站内链接、锚点、商店入口及 FAQ 正文与 SEO 数据一致性。
- 账户使用同源 OIDC + PKCE，精确回调为 `/auth/callback/`；前端不存 client secret。官网在当前浏览器持久保存一份账户会话，跨标签页合并刷新、同步退出和换号；写请求不自动重放，支付返回页不发放权益。官网与插件复用身份服务的 SSO，不互传令牌，不同步本地退出。登录期限由身份服务实际刷新令牌与授权期限决定，持久化不延长这些期限。见[身份规范](../../docs/PRODUCTION_IDENTITY.md)和[支付规则](../../docs/STRIPE_BILLING.md)。

浏览器检查入口见[脚本说明](../../scripts/README.md#官网验收)，覆盖17 语、加载与失败、图片切换、登录返回和订阅交互。

定价页采用套餐卡与统一权益对照表：卡片展示周期总价、每月折合价、实际月额度差值，以及免费模型／付费新增模型；年付优惠以可比报价计算并配装饰性 SVG。对照表只强调有差异的权益，共同功能保持普通样式。模型名称来自公开目录，不在各语言重复维护。完整模型选择协议见[模型选择设计](../../docs/TRANSLATION_MODEL_SELECTION_DESIGN.md)。

定价对照表的长解释收在对应功能标题旁的信息图标中，支持悬停、键盘聚焦和点按；Esc、焦点离开或点击外部关闭。提示复用当前主题令牌，按视口定位以适配窄屏和 RTL；窄屏表格可横向滚动并固定行标题，不增加请求或将说明复制到每个套餐单元格。

套餐本地预览使用[脚本说明](../../scripts/README.md#官网验收)中的隔离环境；界面验收不代表真实支付或模型已接入。
