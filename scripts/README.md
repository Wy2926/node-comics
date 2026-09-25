# 脚本入口

从仓库根目录执行。脚本按不同依赖和验证边界保留；同一工具不在多份历史实施记录中重复维护启动方法。

## 运行与运维

| 入口 | 用途与前提 |
| --- | --- |
| `bootstrap.ps1` | 生成本地控制服务配置；`-Start` 启动 Docker，`-Production` 使用独立生产配置。见[后端说明](../backend/README.md) |
| `database_backup.py` / `verify_database_restore.py` | 数据库备份与新库恢复演练。连接、隔离校验、PostgreSQL 客户端要求见[运维说明](../docs/OPERATIONS.md) |
| `export_openapi.py` | 从当前后端导出机器契约，见[契约说明](../contracts/README.md) |
| `remove-test-temporaries.ps1` | 默认只预览登录 / Drive 小窗口验收的隔离 profile、Drive 扩展副本及登录构建日志；加 `-Apply` 才删除。保留截图、结果报告、源码、配置及全部 `output/` 交付物；拒绝越界路径与链接目录 |

Python 脚本需准备 `backend/requirements.txt` 中的依赖；仓库不附带已安装的虚拟环境。默认后端回归使用[测试 Compose](../deploy/compose.tests.yaml)，不读取产品环境文件。单独运行运维工具前，按对应文档准备其配置。

## 验证工具

| 工具 | 验证边界 |
| --- | --- |
| `verify_reading_api.mjs` | 临时 API、worker、合成供应商与浏览器的完整阅读链路 |
| `verify_reading_translations.mjs` / `verify_reader_retry.mjs` / `verify_history_removal.mjs` | 新容器 / 目录夹具、模拟接口下的阅读窗口、限流、恢复，以及未知地址回退和无历史轮询；专用 Vite 5176，检查当前页与后三页、分钟退避、UUID 快照核实、下载重试和位置恢复 |
| `verify_translation_channels.mjs` | Vite 5176 的独立渠道夹具；实际 Chromium 操作设置、MTU 模拟登录、未登录翻译、模式与渠道切换、缓存清理重译、互联网离线标记；不访问真实 MTU |
| `verify_translation_channel_host.mjs` | 已构建 MV3 扩展、隔离 profile、本机 MTU 模拟服务；原位翻译超过 35 秒无响应、强停后台后读取宿主回执且不重发、零磁盘预算跨上下文读取和清理；不调用真实算力引擎 |
| `verify_translation_channel_live.mjs` | 显式运行的真实本机 MTU 验收；通过构建后设置页登录，发送一张合成图，验证译图原位显示与刷新复用。用 `MTU_USERNAME` / `MTU_PASSWORD` 环境变量提供凭据；默认 `MTU_BASE_URL=http://127.0.0.1:8000/`，仅允许回环地址。真实执行服务端配置的引擎；扩展副本预授予本机权限，结束后注销测试会话并删除隔离 profile；报告不保存凭据 |
| `verify_membership_admin.mjs` | 隔离后台的赠送与分钟配置 |
| 插件 `tests/billing-focus-fixture.html` | Vite 指定 5192 端口后打开，点击“运行回归检查”；模拟订阅接口与窗口交接，验证焦点刷新、并发打开、返回对账和失败重试，不读取真实账户 |
| `verify_inline_translation.mjs` / `verify_popup.mjs` | 构建后的 MV3 扩展与隔离网页，覆盖原位翻译与弹窗；原位回归包含自动翻译关闭时的右键入口、通用／站点识别及 Comix 图片和画布。真实 Comix 开关见[站点说明](../apps/extension/src/sources/sites/comix/README.md#网页原位翻译回归)，浏览器可用 `CHROMIUM_PATH` 指定；网站下载顺序、暂停恢复现由 `tests/website-downloads.test.ts` 与网站生命周期脚本验证 |
| `verify_simple_reading.mjs` | 桌面单来源新基线：自动导入、散图拒绝、重复文件续读、120 页窗口、浏览器重启、格式解码、失败隔离、最近阅读时间、跨虚拟列表批量移除、设置对齐和来源账户展示；窄屏不在兼容范围 |
| `verify_source_database_baseline.mjs` | 在隔离扩展 profile 中先创建残缺旧 v1 库，再验证新基线导入、阅读、重开且旧库不变；另检查当前基线缺表的明确错误，无未处理 Promise |
| `verify_drive_import.mjs` | 新建隔离扩展 profile、专用 HTTPS 测试页与模拟 Google 服务，覆盖 CBZ 选择、直接阅读、位置恢复、索引失败和授权复用；`TEST_DRIVE_FORMAT=mobi` 改用未加密 MOBI 并检查 DRM 拒绝；统一覆盖首次连接、再次自动跳转 Google、取消、真实浏览器重启后的自动跳转与断开检查，不读取用户 Chrome 或真实云盘，真实授权边界见 [Drive 说明](../apps/drive-connect/README.md) |
| `verify_login_popup.mjs` | 构建后的 Chrome 扩展、隔离 profile 与本机 TLS 模拟 OIDC / API；使用真实 `launchWebAuthFlow` 检查 600 × 760 登录窗口、主窗口标签不变、关闭取消、拒绝后重试、成功自动关闭、PKCE 交换及第 2 页阅读位置恢复。需 Python `cryptography`、自制 `pages.cbz` 和下方 Playwright / 浏览器变量；不访问真实身份服务 |
| `verify_source_export.mjs` | 新基线解压扩展：完整源文件逐字节导出、3 页 CBZ 与 PDF 可重新解析；仅自制样本与本机下载 |
| `verify_website_source_lifecycle.mjs` | 本机 TLS / 隔离 DNS 下操作真实网站嵌入按钮、直接阅读、来源标签页、按需取图和主动下载；重开并让图片源失败后已下载页仍可读 |
| `verify_source_image_cache.mjs` | 构建后的 MV3 扩展、隔离 profile 与本机 HTTP 图片服务；不使用会禁用缓存的请求拦截，复现可缓存 503，检查图片重试访问网络、位置保持及成功后的应用缓存复用。使用下方 Playwright / 浏览器变量，运行 `node scripts/verify_source_image_cache.mjs`，结果在 `artifacts/source-image-cache/` |
| `verify_image_transport.mjs` | 构建后的 MV3 扩展及公共取图代码、隔离 profile 和真实本机 HTTP 服务；验证无 CORS、通用 Referer、防盗链失败、逐跳授权、跨来源请求头隔离、循环跳转、显式引用策略、合成 Cookie、并发和取消清理。设置下方 `PLAYWRIGHT_MODULE` / `TEST_CHROMIUM` 后运行 `node scripts/verify_image_transport.mjs`，结果在 `artifacts/image-transport/`；不访问真实账户或翻译服务 |
| 插件 `tests/reader-window-fixture.html` | Vite 独立 5181 端口，30 章 × 120 页合成夹具；检查 3 章 / 11 页 DOM 上限、跳页、偏移恢复与失败；桌面目标浏览器检查截图及位置恢复 |
| `verify_reader_directory.mjs` | Vite 独立 5181 端口，`tests/reader-directory-fixture.html` 的 620 章合成目录；覆盖当前项超出首批、倒序、嵌套分组、搜索恢复、状态刷新不抢滚动、页面缩略图、失败／未就绪和重开位置；截图在 `artifacts/reader-directory/` |
| `verify_extension_theme.mjs` | 新书架、真实导入、菜单 / 导出弹窗、4 色 × 亮暗主题、阅读浮层与位置恢复；默认 Vite 5175，可用 `TEST_READER_URL` 指定隔离主应用 |
| `verify_catalog_sync.mjs` | 本机 TLS / 合成目录下的自动同步、动态分组、更新提示、失败保留与阅读位置；依赖 Python cryptography，使用下方相同浏览器变量 |
| `verify_source_covers.mjs` | 构建后的隔离 MV3：五站封面、缓存、重试、更新和阅读位置。使用 `PLAYWRIGHT_MODULE` / `TEST_CHROMIUM`；默认合成数据，`RUN_LIVE_COVERS=1` 读取公开样本。预授权／模拟授权，不验原生弹窗；产物在 `artifacts/source-covers/` |
| Comix `tests/verify-*.mjs` | 站点目录、图片还原、完整阅读器与请求头隔离；样本／真实网络边界见[Comix 说明](../apps/extension/src/sources/sites/comix/README.md) |
| 瓜子漫画 `tests/verify-browser.mjs` | 真实公开 HTTP、隔离预授权 MV3：弹窗／链接／站内导入统一身份、章节 HTML 复用、整章取图、专门封面、目录刷新和页码恢复；运行方式和边界见[站点说明](../apps/extension/src/sources/sites/guazimanhua/README.md) |
| `verify_chapter_imports.mjs` | 真实 DM5／Comic PASH 裸章节 → 完整作品目录 → 正文清单，核对归属及一次性 HTML 复用，无来源标签页；构建后按下方 `PLAYWRIGHT_MODULE` / `TEST_CHROMIUM` 运行，结果在 `artifacts/chapter-imports/`。预授权隔离 MV3，不下载正文图片、不调用产品 API 或翻译模型 |
| `verify_comicpash.mjs` | Comic PASH 完整目录、整章取图还原、站内导入与阅读位置恢复；隔离样本／真实来源开关见[站点说明](../apps/extension/src/sources/sites/comicpash/README.md) |
| `verify_r2_download.mjs` | 模拟 R2 响应下的浏览器下载与权限处理，不访问 Cloudflare |
| `verify_cluster_r2.py` / `probe_r2.py` | 真实 R2 接入；运行前阅读脚本中的对象范围与清理规则，不作为普通离线回归 |
| `smoke_api.py` | 默认检查 API；`--translate` 会发起真实付费图片请求，保存请求 UUID 以便核实与恢复，不自动重建未知请求 |

浏览器脚本需要 Node.js、已安装的 Playwright 和对应浏览器；`PLAYWRIGHT_MODULE` 可指向已有模块。脚本使用各自的隔离端口、夹具或扩展配置，并非所有工具支持相同环境变量。阅读与后台检查的完整启动顺序见[阅读契约验收](../docs/READING_TRANSLATION_CONTRACT.md#10-验证入口)。模拟图片只能验证交互，不能证明翻译效果。

### 来源与阅读验收

先准备 Pillow、ReportLab 与 `generate_import_fixtures.py` 所需依赖，生成仓库自制样本；在扩展目录完成 `npm ci` 与 `npm run build`。从仓库根目录运行：

```powershell
python scripts/generate_import_fixtures.py
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<可加载解压扩展的 Chrome for Testing 或 Edge 可执行文件绝对路径>'
$env:TEST_BROWSER_NAME = 'chrome-extension'
node scripts/verify_simple_reading.mjs
node scripts/verify_source_database_baseline.mjs
node scripts/verify_source_export.mjs
node scripts/verify_website_source_lifecycle.mjs
```

上述脚本的 `PLAYWRIGHT_MODULE` 默认是可由 Node 解析的 `playwright`，未设置 `TEST_CHROMIUM` 时使用已安装的 Playwright Chromium；也可显式指定可执行文件。扩展验收须使用支持脚本加载解压扩展的浏览器，格式、导出与网站脚本固定检查扩展。网站脚本还需 Python 的 `cryptography`，用临时 TLS 证书和 DNS 映射将测试站点完全隔离在本机，不连接公开站点。所有脚本均新建隔离 profile、拦截产品 API 并仅读取自制样本；截图与脱敏结果位于被忽略的 `artifacts/source-architecture/`。

单来源验收固定检查构建后的 `.output/chrome-mv3`，不需要 Vite。结果位于 `artifacts/simple-reading/`，其余来源验证仍位于 `artifacts/source-architecture/`。运行报告用于当次验收，不沿用历史通过数。

Drive 完整交互回归沿用上述 Playwright / 浏览器变量和自制 `pages.cbz`，需要 Python `cryptography`。构建扩展时须配置 `VITE_DRIVE_CONNECT_URL`（HTTPS 的 `/drive-connect/index.html`），统一客户端配置见 [drive-connect](../apps/drive-connect/README.md)。脚本读取构建中的地址，在新建 profile 的隔离 DNS 内将授权页、Google 顶层授权 / Picker 与 Drive API 全部映射到本机 TLS 夹具，不访问真实 Google 或用户 profile，也不读取实际授权页配置。脚本通过 CDP 禁用第三方 Cookie，实际导航到模拟 Google 页面后回调并导入；支持 `TEST_EXTENSION_DIR` 指定 `.output/edge-mv3`，配合 `TEST_CHROMIUM` 指向 Edge。模拟回调不证明真实 Google 返回字段已经验收。

```powershell
node scripts/verify_drive_import.mjs
$env:TEST_DRIVE_FORMAT = 'mobi'
node scripts/verify_drive_import.mjs
```

各浏览器均验证首次手动连接、后续无需点击本站按钮即可自动跳转、取消后停留、只连接账户与零文件导入后的设置展示。脚本真实关闭、重开隔离浏览器，检查 session 已清空而本地账户记录保留、再次进入仍自动跳转 Google，以及断开后恢复手动连接。它不验证真实 Google grant 或长期续期。结果与截图写入 `artifacts/source-architecture/drive/run-*/`；token 为随机模拟数据，不写入报告。

单来源格式与导入统一使用 `verify_simple_reading.mjs`。可选规模检查在插件目录设置 `NC_CATALOG_SCALE=1` 后运行 `npm test -- tests/catalog-scale.test.ts`；该检查使用 fake-indexeddb，不是实际设备性能基准。

## 样本与共享模块

### 页面图片读取研究

`probe_page_image_access.mjs` 不依赖产品构建。它创建临时 MV3 扩展、隔离 profile 和两个本机 HTTP 来源，比较网站授权下的页面像素、原始文件和缓存读取；没有外部图片、账户或翻译请求。结果在 `artifacts/page-image-access/<运行 ID>/`，结论见[调研文档](../docs/PAGE_IMAGE_ACCESS_RESEARCH.md)。

```powershell
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<支持加载解压扩展的 Chromium 或 Edge 可执行文件绝对路径>'
node scripts/probe_page_image_access.mjs
```

可选设置 `PROBE_DEBUGGER=1` 或 `PROBE_PAGE_CAPTURE=1`，只给临时研究扩展增加对应权限，验证已加载跨域图片的原文件读取。默认不开启，两者可独立运行。页面捕获实验输出自制页面 MHTML，其解析器仅用于固定实验样本，不是产品 MIME 解析实现。`TEST_CHROMIUM` 未设置时依次使用 `CHROMIUM_PATH` 或 Playwright 默认浏览器。

`PROBE_REQUEST_CONTEXT=1` 为临时扩展增加产品已有的 `declarativeNetRequestWithHostAccess` 权限，验证页面可加载而后台缺少 Referer 时 403、公共来源请求规则下成功、规则清理后再次拒绝的场景。样本不含 CORS 响应头，测试来源拒绝与页面 CORS 的区别。

### 共享模块

- `generate_import_fixtures.py` 生成原创导入样本，输出到被忽略的 `artifacts/import-validation/`。
- `translation_client.py`、`local_import_helpers.mjs` 供检查脚本复用，不是独立命令。

原本绑定特定 Windows 虚拟环境的本机常规翻译启动器已移除。需要计算节点时，按[classic-engine 安装说明](../services/classic-engine/README.md)单独准备环境和模型。
