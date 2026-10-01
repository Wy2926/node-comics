# 脚本入口

## 商店截图

`node scripts/prepare_readme_store_screenshots.mjs [背景图路径] [输出目录]` 使用根目录中英文 README 引用的真实截图裁剪排版，输出两种语言各 6 张 1280×800 RGB PNG、总览与记录来源摘要和裁剪坐标的清单。默认背景为 `output/imagegen/blue-manga-store/background.png`，默认输出目录为该背景所在的 `output/imagegen/blue-manga-store/`。需先安装官网模块的 `sharp` 依赖。脚本不调用模型；背景需单独准备，截图尺寸改变时必须重新核对裁剪区域。输出文件会覆盖同目录内的同名产物。

从仓库根目录执行。Python 工具按[后端](../backend/README.md)安装依赖；浏览器工具需要 Node.js、Playwright 和支持解压扩展的 Chromium。脚本启动条件以下表和文件内配置为准，结果写入忽略的 `artifacts/`。

## 运行与运维

| 入口 | 用途 |
| --- | --- |
| `bootstrap.ps1` | 本地控制服务初始化与启动，见[后端](../backend/README.md) |
| `switch_release.py` / `retire_release.py` | OpenResty 事务式 API／静态切换、失败回退及旧进程安全排空，见[部署规范](../docs/DEPLOYMENT.md) |
| `prepare_static_release.py` | 准备独立官网／后台的不可变目录、安全头与资源保留池，不自动激活 |
| `tests/rehearse_deployment.py` | 隔离 Docker 中真实代理切换、慢上传、SSE、合成供应商任务与回退；默认清理本轮资源，报告写入 artifacts |
| `database_backup.py` / `verify_database_restore.py` | [备份与隔离恢复](../docs/OPERATIONS.md) |
| `export_openapi.py` | [导出 API 契约](../contracts/README.md) |
| `validate_analytics.py --env-file <私密配置路径>` | 用后端实际载荷格式向 GA4 验证端点严格校验全部插件事件；不调用收集端点、不写报表，不能验证 secret 或真实入库。只读指定文件的 GA4 配置（未指定时取进程环境），结果写入 `artifacts/analytics-config/validation.json` |
| `verify_extension_release.py` | 校验安装包与已填写的永久下载地址，见[部署规范](../docs/DEPLOYMENT.md) |
| [remove-obsolete-artifacts.ps1](remove-obsolete-artifacts.ps1) | Windows 清理旧测试、报告与重建产物；默认预览，`-Apply` 执行，保留当前发布包、营销图片与节点资料 |

清理命令：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remove-obsolete-artifacts.ps1`。确认清单并关闭测试／构建后追加 `-Apply`；旧节点测试目录访问被拒绝时，改用管理员 PowerShell。范围固定在仓库三处 artifacts 下，不跟随目录链接，不删除 Git 跟踪内容或清单外路径。隔离测试：`python scripts/tests/test_artifact_cleanup.py`。

## 来源与阅读验收

先构建插件，并生成自制导入样本；可复用的原创图片见[样本说明](../samples/README.md)。样本工具需要 Pillow、ReportLab；TLS 网站／Drive 夹具另需 Python cryptography。

```powershell
python scripts/generate_import_fixtures.py
$env:VITE_DRIVE_CONNECT_URL = 'https://drive-fixture.test/connect'
npm --prefix apps/extension run build
Remove-Item Env:VITE_DRIVE_CONNECT_URL
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<支持加载解压扩展的浏览器可执行文件>'
$env:TEST_BROWSER_NAME = 'chrome-extension'
node scripts/verify_simple_reading.mjs
```

`verify_simple_reading.mjs` 包含模拟 Drive 账户断开验收，因此构建时需设置上面的夹具连接地址以启用后台消息处理；该地址仅用于测试构建，真实发布使用生产配置。可用 `TEST_EXTENSION_DIR` 指向单独的验收构建。未设置路径时使用脚本默认 Playwright／浏览器。原位翻译脚本使用 `CHROMIUM_PATH`；各脚本支持的变量以源码为准。默认使用隔离 profile 和自制样本，真实网络工具在表中单列。

| 工具 | 检查范围 |
| --- | --- |
| `verify_comic_search.mjs` | 跨语言查找三入口、逐站结果／重试、镜像去重、导入和阅读位置；网站／名称接口为隔离夹具，真实HTTP见各站README |
| `verify_discovery.mjs` | 生产 MV3 发现／详情／来源导入、返回位置、分页失败／限流及主题的隔离 HTTP 夹具；加 `--live` 只检查真实 AniList 公共列表和详情 |
| `verify_simple_reading.mjs` / `verify_source_database_baseline.mjs` | 单来源导入、格式、书架、批量移除、新库和重启恢复 |
| `verify_shelf_performance.mjs` | 隔离 MV3 书架的重复切换、封面复用、数据库读取量、菜单与滚动位置；`SHELF_PERF_BOOKS=17` 指定漫画数，`SHELF_PERF_LABEL=before` 记录基准，默认 `after` 检查读取范围与封面复用，`SHELF_PERF_EXTENSION` 可指定对照构建 |
| `verify_source_export.mjs` / `verify_website_source_lifecycle.mjs` | 导出、网站导入、按需读取与主动下载 |
| `verify_catalog_sync.mjs` / `verify_source_covers.mjs` | 目录更新、失败保留与封面；后者 `RUN_LIVE_COVERS=1` 读取公开来源 |
| `verify_image_transport.mjs` / `verify_source_image_cache.mjs` | [公共取图](../docs/IMAGE_ACCESS.md)、权限、Referer、重定向与缓存重试 |
| `verify_drive_import.mjs` | 模拟 Google／Drive 的连接、导入、重启与撤权；构建需配置连接页，`TEST_DRIVE_FORMAT=mobi` 切换 MOBI 样本 |
| `verify_login_popup.mjs` | 模拟 OIDC、PKCE、取消、失败重试与登录后阅读恢复 |
| `verify_inline_translation.mjs` / `verify_popup.mjs` | 原位翻译与弹窗；各站点真实网络开关见[站点说明](../docs/SITE_ADAPTERS.md#现有站点) |
| `verify_analytics.mjs` | 隔离 Chromium MV3 检查默认关闭、书架卡片拒绝／关闭不重弹、搜索与导入入口可用、12 种主题组合及窄宽大字、主动同意、跨标签同步、白名单无凭据请求、失败留队列、撤回清理与重新同意；后台及页面 HTTP(S) 全部模拟，不向真实 API 或 GA4 发送；截图写入 `artifacts/analytics/` |
| `verify_chapter_imports.mjs` | 真实 DM5／Comic PASH 裸章节归属与完整目录 |
| `verify_comicpash.mjs`、站点 `tests/verify-*.mjs` | 站点协议与浏览器流程，环境及网络范围见各站点 README |
| `verify_reading_translations.mjs` / `verify_reader_retry.mjs` / `verify_history_removal.mjs` | Vite 5176 模拟阅读器、分钟退避、恢复与重试 |
| `verify_reading_api.mjs` | 临时 API／worker 与合成供应商，启动顺序见[翻译契约](../docs/READING_TRANSLATION_CONTRACT.md#9-验证入口) |
| `verify_translation_channels.mjs` / `verify_translation_channel_host.mjs` | 渠道设置、模拟 MTU、后台中断与缓存，见[渠道规范](../docs/TRANSLATION_CHANNELS.md#验证) |
| `verify_translation_channel_live.mjs` | 真实回环 MTU；使用 `MTU_USERNAME`、`MTU_PASSWORD`、可选 `MTU_BASE_URL`，实际调用服务端引擎 |
| `verify_reader_directory.mjs` | Vite 5181 的目录夹具；同端口 `reader-window-fixture.html` 检查有限图片窗口 |
| `verify_reader_scroll.mjs` | Vite 5181 的阅读窗口夹具；模拟翻译状态与译图更新，检查章节交界、双向滚动、窗口淘汰、失败与位置恢复 |
| `verify_reader_preload.mjs` | 同一 Vite 5181 夹具的 `?highres=1` 样本；真实 4000×6000 原图的邻页加载、非当前可见页、并排／单页、失败隔离、位置恢复与图片 URL 释放，不访问源站或翻译服务 |
| `verify_extension_theme.mjs` | Vite 5175 或 `TEST_READER_URL`，主题、菜单与位置恢复 |
| `verify_membership_admin.mjs` / `verify_admin_completion.mjs` | 会员、赠送与管理操作，见[后台验收](../docs/ADMIN_CONSOLE.md#验证) |
| `verify_quota_campaign_admin.mjs` | 同一独立重建的管理夹具，额度活动创建与期限调整、启停、审计、回执恢复、并发冲突、发放记录与窄屏布局 |
| `verify_membership_renewal.mjs` | 先在插件目录运行 `npx vite --host 127.0.0.1 --port 5192 --strictPort`；模拟赠送顺延、续费取消与回执丢失后刷新、无订阅赠送期间禁止即时购买及窄屏布局 |
| `verify_translation_overlay.mjs` | 真实 Chromium 像素、透明度、EXIF/ICC/首帧规范化、摘要与 bbox 校验；可使用实际 LLM 产物验证合成和导出 |
| `verify_overlay_live.py` | 隔离 Docker 中心 + 本机 GPU + 真实文本 LLM；支持静态规范图片或整章目录，逐页保存 UUID、结果与统计，检查结果鉴权和 UUID 重放 |
| `verify_overlay_chapter.mjs <运行目录>` | Vite 5176 + 真实 Chromium 逐页合成真实批次产物，走产品导入与流式 CBZ 导出，独立解包校验全部页面 SHA；不调用 API/LLM |
| `smoke_api.py` / `verify_image_provider_live.py` | API／真实图片供应商；`smoke_api --translate` 才发起付费翻译，未知请求先核实 |

Drive 可用 `TEST_EXTENSION_DIR` 指向 Edge 构建并配套 `TEST_CHROMIUM`；授权页、Google 与 Drive 均由本机 TLS 模拟，真实 Google 授权另验。登录生命周期夹具使用 Vite 5187 的 `auth-lifecycle-fixture.html`；订阅焦点夹具使用 Vite 5192 的 `billing-focus-fixture.html`。

## 官网验收

在 `backend/website` 启动开发或构建预览服务。脚本使用本机 Chrome 和 Playwright，可设置 `PLAYWRIGHT_MODULE`、`WEBSITE_PREVIEW_URL`：

| 工具 | 范围 |
| --- | --- |
| `verify_website_download.mjs` | 五语下载页；指向公开服务时真实下载并核对摘要 |
| `verify_website_pricing.mjs` | 五语无 JavaScript 公示月年价格与开放日期、双卡及六项权益对照、模拟 API 报价／额度接管与月年付切换、加载／空目录／失败保留价格、桌面和手机布局 |
| `verify_website_compare.mjs` | 四种图片、切换、加载失败与恢复 |
| `backend/tests/manual_website_translation_server.py` | 构建后的同源选图／工作台、模拟游客验证与 OIDC、覆盖层合成、本地历史及回执丢失；运行方式见官网 README，不调用真实供应商 |
| `verify_website_account.mjs` | 先在官网目录运行 `npx vite --config tests/account-fixture.config.ts`，固定 5193；模拟账户、赠送顺延、取消续费、回执丢失后刷新、结账与退出，覆盖五语及窄屏 |

完整同源账户流程见[官网 README](../backend/website/README.md)。模拟响应验证交互，真实身份、付款和模型效果分别验证。

## 辅助工具

`probe_page_image_access.mjs` 使用临时研究扩展比较图片像素、原始字节和浏览器缓存；可选 `PROBE_DEBUGGER`、`PROBE_PAGE_CAPTURE`、`PROBE_REQUEST_CONTEXT` 仅影响实验扩展，不改变产品权限。

使用真实后端的浏览器夹具和供应商验证脚本需要 Redis 8：`TEST_REDIS_URL` 指定专用测试实例，默认本机 6379；每次运行使用独立随机命名空间，不使用生产限流状态。纯静态或模拟 HTTP 的页面夹具无此依赖。

## 真实覆盖层链路

使用 [compose.overlay-tests.yaml](../deploy/compose.overlay-tests.yaml) 启动隔离的 PostgreSQL、Redis、API、文本 worker 和维护进程；图像节点运行于本机真实 GPU。Compose 环境文件需设置随机 `OVERLAY_AUTH_SECRET`、测试 TLS 目录 `OVERLAY_TLS_DIRECTORY`，以及可选回环端口 `OVERLAY_API_PORT`。节点注册实际引擎版本，不配置固定指纹。TLS 目录包含仅用于本机的 `server.pem`、`server.key` 和 `ca.pem`，证书 SAN 包含 localhost；不得关闭证书校验。节点 JSON 配置遵循[节点配置](../docs/NODE_CONFIGURATION.md)。

```powershell
docker compose --env-file artifacts/overlay-integration/compose.env -f deploy/compose.overlay-tests.yaml build api
docker compose --env-file artifacts/overlay-integration/compose.env -f deploy/compose.overlay-tests.yaml run --rm migrate
docker compose --env-file artifacts/overlay-integration/compose.env -f deploy/compose.overlay-tests.yaml up -d --no-build --wait
services/classic-engine/.venv-lama/Scripts/python.exe scripts/verify_overlay_live.py `
  --ca artifacts/overlay-integration/tls/ca.pem --key-file .env `
  --runtime-config artifacts/overlay-integration/runtime.json `
  --source <规范化图片或章节目录> --run-dir artifacts/overlay-chapter
```

私有配置仅读取 `TEXT_BASE_URL`、`TEXT_MODEL`、`TEXT_API_KEY`，协议由 `--protocol chat_completions|responses` 指定。脚本实际调用付费文本服务，限制每组一次尝试；先保存 UUID，再发送输入。按实际文件格式发送 MIME，仅接收不需要 EXIF／ICC／首帧转换的静态规范输入；目录按页名自然排序，忽略导出清单，原始文件不改动。

真实图片先经过插件预处理：启动插件 Vite 5176，配置 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM`，执行 `node scripts/verify_translation_inputs.mjs <图片目录> <artifacts 下的输出目录>`。脚本限最多 16 张，通过实际规范化与高质量 WebP 代码生成 `inputs/`，另保留第一张的未压缩基线；`preparation.json` 记录大小、尺寸、预处理耗时和主线程定时器间隔，不把测试文件序列化计入 UI 耗时。将 `inputs/` 作为真实验证器的 `--source`；尺寸准入由中心统一判断，验证器不保留旧的 8192 上限。

批次使用一个测试供应商和物理 GPU 节点。只停用同名旧测试供应商，检测到其他供应商则拒绝运行；复用同一测试 GPU 的节点身份，存在活动租约则拒绝旋转凭据。隔离中心每日额度调至至少页数加 100，并为批次创建新测试读者；供应商测试配置为 60 RPM、8192 输出 token、1800 字节分组和单次尝试。它不调整供应商实际账户配置。

运行目录必须新建，每页保存 `intent.json`、原始字节、结果描述、覆盖文件、常规结果和统计，顶层 `report.json` 持续汇总。明确 429 根据 Retry-After 使用同一 UUID 重试；写入结果未知时只观察原 UUID。单页默认上限 900 秒，失败记录后继续下一页，终态原图结果不下载文件。失败或未知调用先核实已保存 UUID，不能反复新建任务盲试。控制台只输出状态／大小／耗时，不输出 OCR 或凭据。

全部页面终态后，在插件目录启动 Vite 5176，从仓库根目录执行 `node scripts/verify_overlay_chapter.mjs artifacts/overlay-chapter`。它使用现有 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM` 和可选 `PYTHON` 路径，将逐页完整图片、缩略总览、统计和 `translated.cbz` 写入批次的 `browser/`。无文字保留原图；失败页面按产品规则回退原图并在导出清单标明，不能将完整归档误称为全部翻译成功。压缩统计分别记录覆盖文件、原图和浏览器完整图字节，不能把不同编码方式当作同编码质量比较。

脚本隔离安全检查：`python scripts/tests/test_overlay_live.py`。产物和凭据不提交仓库。验收后仅清理该 Compose 项目及其专用卷；其他 Docker 环境不受影响。

`translation_client.py`、`local_import_helpers.mjs` 是脚本共享模块；`generate_import_fixtures.py` 只生成自制样本。脚本使用的数据、profile 和结果不提交仓库。
