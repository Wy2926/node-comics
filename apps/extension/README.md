# Node Comics 插件

React / TypeScript / WXT Manifest V3 漫画阅读器，翻译由后端执行。漫画使用单来源模型：本地未加密 MOBI、CBZ/ZIP、CBR/RAR、PDF，Google Drive CBZ/ZIP、未加密 MOBI，或专门适配的网站。选择文件自动导入，点卡片直接读；不支持散图导入、资料编辑、多来源和版本管理。

产品行为见[单来源阅读](../../docs/SIMPLE_COMIC_READING_DESIGN.md)，存储采用 `node-comics-reading-v2-*` 空库基线，不迁移或兼容旧书架。界面验收以桌面浏览器为目标。新客户端需要重新导入漫画；旧本机数据库保留但不读取。

翻译使用逐图 UUID、按需原图上传和批量快照，上传自动启动；本地页面键为固定 64 字符 SHA-256。没有阅读会话续租或旧 API 回退，客户端与后端须使用相同的新[翻译契约](../../docs/READING_TRANSLATION_CONTRACT.md)。

## 运行与构建

要求 Node.js 22.23+、npm 10+。从本目录执行：

```powershell
npm ci
npm run dev          # http://127.0.0.1:5173
npm run check        # 类型、模块依赖、环依赖与可达性
npm test
npm run build        # .output/chrome-mv3
npm run build:web    # dist-web
npm run zip
```

Chrome / Edge 在扩展管理页打开开发者模式，加载 `.output/chrome-mv3`。稳定扩展 ID 为 `aiajdjliifeeaogpalejpggkiccjbneo`；更新构建后需重新加载。产品服务由 [service.ts](src/service.ts) 固定为 `https://comics.nodelane.net`，本地 Vite 不会自动切到本地 API，用户界面不提供服务地址或供应商配置。

独立沙盒可在构建前设置 `$env:VITE_API_BASE='https://<沙盒域名>'`，客户端及精确 host permission 同步生成；沙盒须使用独立数据库、支付配置并允许实际扩展来源。正式构建前用 `Remove-Item Env:VITE_API_BASE -ErrorAction SilentlyContinue` 清除此覆盖。Drive 的 HTTPS 连接页及两类 OAuth client 配置见 [drive-connect](../drive-connect/README.md)。

Firefox MV3：

```powershell
npm run zip -- --browser firefox --mv3
npx --no-install web-ext lint --source-dir .output/firefox-mv3
```

Edge 商店提交包：运行 `npm run zip:edge`，产物为 `.output/node-comicsextension-<版本>-edge.zip`。此构建不包含 Chrome 固定扩展 ID 使用的 `manifest.key`；不要将带有该字段的 Chrome 包提交到 Edge 商店。

Edge 的 Google Drive 构建须设置 `$env:VITE_DRIVE_CONNECT_URL='https://comics.nodelane.net/drive-connect/index.html'`。网页连接在同一授权窗口跳转 Google 完成选文件后返回，需同步发布新版 `apps/drive-connect/connect.js`，并在 Google Web OAuth 客户端登记该完整地址为 Authorized redirect URI。Chrome 托管连接保持原有模式；细节及真实授权验收边界见 [Drive 配置](../drive-connect/README.md)。

固定 Firefox ID 为 `comics@nodelane.net`；数据同意声明与最低版本以 [wxt.config.ts](wxt.config.ts) 为准。打包不代表签名、上架或真实登录／取图已通过；浏览器运行与原生权限需单独验证。Firefox 凭据使用扩展 origin 的 IndexedDB，Chrome / Edge 使用限制为 `TRUSTED_CONTEXTS` 的本地存储，见[身份说明](../../docs/PRODUCTION_IDENTITY.md)。

## 开发入口

| 范围 | 入口 |
| --- | --- |
| 网站适配 | [精简开发规范](../../docs/SITE_ADAPTERS.md)，站点代码与说明在 `src/sources/sites/<id>/` |
| 来源、页面和缓存 | [来源架构](../../docs/COMIC_SOURCE_ARCHITECTURE.md)、[格式约束](../../docs/IMPORT_FORMATS_AND_CACHE.md) |
| 阅读翻译与恢复 | [翻译接口契约](../../docs/READING_TRANSLATION_CONTRACT.md)、[网页原位翻译](../../docs/IN_PAGE_TRANSLATION.md) |
| 账户、额度和支付 | [身份](../../docs/PRODUCTION_IDENTITY.md)、[会员规则](../../docs/MEMBERSHIP_AND_QUOTAS.md)、[订阅](../../docs/STRIPE_BILLING.md) |
| UI 与文案 | [共享视觉令牌](../../docs/POPUP_AND_THEME.md)、[16 种界面语言](../../docs/UI_INTERNATIONALIZATION.md) |
| 匿名适配申请与插件反馈 | [后台接口与边界](../../docs/ADMIN_CONSOLE.md#匿名网站申请与插件反馈) |

新漫画默认原图，查看方式按漫画保存；明确选择翻译后自动处理当前页与后三页。逐页保存操作编号，响应丢失先核实；已有原图无需重传。后端持久任务继续执行，客户端按账户增量同步状态并按需下载译图。来源 Cookie／令牌不上传，未登录可读本地原图。

网站目录只读，更新能力由适配器显式声明；同步不下载新章节图片，失败保留旧目录和位置。账户列表由文件来源驱动提供，不由 UI 判断具体供应商。品牌素材随 `public/brand` 和 `src/assets/brand` 打包，构建不依赖 `output/`。

## 隔离浏览器验证

完整入口、环境变量和样本生成见[脚本说明](../../scripts/README.md)。书架、导入、持久化和网站读取使用构建后的 MV3 扩展；阅读计划与身份 UI 可用以下专用夹具：

| 夹具 | 启动与检查 |
| --- | --- |
| 阅读计划 | `npm run dev -- --port 5176`，打开 `/tests/reader-fixture.html`；`?plus`、`?redrawOutcome=success` 或 `failure` 控制模拟响应 |
| 登录生命周期 | `npm run dev -- --port 5187`，打开 `/tests/auth-lifecycle-fixture.html?login=oidc#account`；Alt+E 模拟失败、Alt+S 模拟成功；`login=config-error/loading/development` 检查其他状态 |
| 订阅焦点恢复 | `npm run dev -- --port 5192`，打开 `/tests/billing-focus-fixture.html`，点击运行回归检查 |

夹具使用专用端口、隔离数据和模拟身份／供应商。检查加载、失败重试、重复操作、关闭重开与阅读位置；模拟图只验证交互，不证明模型翻译效果。真实 Google 授权、公开网站、OIDC、支付、Firefox 和生产环境分别验收，不沿用历史通过数。
