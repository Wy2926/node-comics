# 脚本入口

从仓库根目录执行。脚本按不同依赖和验证边界保留；同一工具不在多份历史实施记录中重复维护启动方法。

## 运行与运维

| 入口 | 用途与前提 |
| --- | --- |
| `bootstrap.ps1` | 生成本地控制服务配置；`-Start` 启动 Docker，`-Production` 使用独立生产配置。见[后端说明](../backend/README.md) |
| `database_backup.py` / `verify_database_restore.py` | 数据库备份与新库恢复演练。连接、隔离校验、PostgreSQL 客户端要求见[运维说明](../docs/OPERATIONS.md) |
| `export_openapi.py` | 从当前后端导出机器契约，见[契约说明](../contracts/README.md) |

Python 脚本需准备 `backend/requirements.txt` 中的依赖；仓库不附带已安装的虚拟环境。默认后端回归使用[测试 Compose](../deploy/compose.tests.yaml)，不读取产品环境文件。单独运行运维工具前，按对应文档准备其配置。

## 验证工具

| 工具 | 验证边界 |
| --- | --- |
| `verify_reading_api.mjs` | 临时 API、worker、合成供应商与浏览器的完整阅读链路 |
| `verify_reading_plans.mjs` / `verify_reader_retry.mjs` / `verify_history_removal.mjs` | 新容器 / 目录夹具、模拟接口下的阅读窗口、限流、恢复，以及未知地址回退和无历史轮询；专用 Vite 5176，[20 项真实浏览器回归](../docs/validation/READING_FLOW_2026_09_22.md) |
| `verify_membership_admin.mjs` | 隔离后台的赠送与分钟配置 |
| 插件 `tests/billing-focus-fixture.html` | Vite 指定 5192 端口后打开，点击“运行回归检查”；模拟订阅接口与窗口交接，验证焦点刷新、并发打开、返回对账和失败重试，不读取真实账户 |
| `verify_inline_translation.mjs` / `verify_popup.mjs` | 构建后的 MV3 扩展与隔离网页，覆盖原位翻译与弹窗；网站下载顺序、暂停恢复现由 `tests/website-downloads.test.ts` 与网站生命周期脚本验证 |
| `verify_simple_reading.mjs` | 单来源新基线：自动导入、散图拒绝、重复文件续读、120 页窗口、浏览器重启、格式解码、失败隔离、卡片菜单与窄屏 |
| `verify_source_database_baseline.mjs` | 在隔离扩展 profile 中先创建残缺旧 v1 库，再验证新基线导入、阅读、重开且旧库不变；另检查当前基线缺表的明确错误，无未处理 Promise |
| `verify_drive_import.mjs` | 新建隔离扩展 profile、专用 HTTPS 测试页与模拟 Google 服务，覆盖 CBZ 选择、直接阅读、索引失败和授权复用；`TEST_DRIVE_AUTH_MODE=chrome` 增加模拟 Chrome Identity、真实浏览器重启后的静默恢复和断开检查，不读取用户 Chrome 或真实云盘，见 [Drive 授权回归](../docs/validation/DRIVE_AUTH_2026_09_23.md) |
| `verify_source_export.mjs` | 新基线解压扩展：完整源文件逐字节导出、3 页 CBZ 与 PDF 可重新解析；仅自制样本与本机下载 |
| `verify_website_source_lifecycle.mjs` | 本机 TLS / 隔离 DNS 下操作真实网站嵌入按钮、直接阅读、来源标签页、按需取图和主动下载；重开并让图片源失败后已下载页仍可读，见[本轮验收](../docs/validation/SOURCE_ARCHITECTURE_2026_09_22.md) |
| 插件 `tests/reader-window-fixture.html` | Vite 独立 5181 端口，30 章 × 120 页合成夹具；检查 3 章 / 11 页 DOM 上限、跳页、偏移恢复、失败与窄屏，见[阅读窗口证据](../docs/validation/READER_WINDOW_2026_09_22.md) |
| `verify_extension_theme.mjs` | 新书架、真实导入、菜单 / 导出弹窗、4 色 × 亮暗主题、阅读浮层和窄屏；默认 Vite 5175，可用 `TEST_READER_URL` 指定隔离主应用 |
| `verify_comicpash.mjs` | Comic PASH 画布发现与导入，隔离样本／真实来源开关见[网站图片适配](../docs/SITE_ADAPTERS.md) |
| `verify_r2_download.mjs` | 模拟 R2 响应下的浏览器下载与权限处理，不访问 Cloudflare |
| `verify_cluster_r2.py` / `probe_r2.py` | 真实 R2 接入；运行前阅读脚本中的对象范围与清理规则，不作为普通离线回归 |
| `smoke_api.py` | 默认检查 API；`--translate` 会发起真实付费图片请求，保存操作编号以便核实与恢复，不自动重建未知请求 |

浏览器脚本需要 Node.js、已安装的 Playwright 和对应浏览器；`PLAYWRIGHT_MODULE` 可指向已有模块。脚本使用各自的隔离端口、夹具或扩展配置，并非所有工具支持相同环境变量。阅读与后台检查的完整启动顺序见[阅读契约验收](../docs/READING_TRANSLATION_CONTRACT.md#10-实现与验证记录)。模拟图片只能验证交互，不能证明翻译效果。

### 新来源架构验收

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

单来源验收固定检查构建后的 `.output/chrome-mv3`，不需要 Vite。结果位于 `artifacts/simple-reading/`，其余来源验证仍位于 `artifacts/source-architecture/`。当前结果见[单来源验收](../docs/validation/SIMPLE_READING_2026_09_23.md)。

Drive 完整交互回归沿用上述 Playwright / 浏览器变量和自制 `pages.cbz`，需要 Python `cryptography`。构建扩展时须配置 `VITE_DRIVE_CONNECT_URL`（HTTPS 的 `/drive-connect/index.html`）；Chrome 托管授权构建另设 `VITE_GOOGLE_CHROME_CLIENT_ID`，两种客户端配置见 [drive-connect](../apps/drive-connect/README.md)。脚本读取构建中的地址，在新建 profile 的隔离 DNS 内将授权页、GIS / Picker 与 Drive API 全部映射到本机 TLS 夹具，不访问真实 Google 或用户 profile，也不读取实际授权页配置。

```powershell
$env:TEST_DRIVE_AUTH_MODE = 'web'
node scripts/verify_drive_import.mjs
$env:TEST_DRIVE_AUTH_MODE = 'chrome'
node scripts/verify_drive_import.mjs
```

网页模式验证有效 token 复用与自动打开 Picker。Chrome 模式模拟 `identity.getAuthToken`，还会真实关闭、重开隔离浏览器，检查 session 已清空而本地账户记录保留、通过非交互 API 恢复，以及断开后不能恢复。它不验证 Google 实际 grant 或长期续期。结果与截图写入 `artifacts/source-architecture/drive/run-*/`；token 为随机模拟数据，不写入报告。

旧作品管理、导入归属和通用网页图片导入脚本已删除。格式与新模型的验收统一使用 `verify_simple_reading.mjs`；历史验证记录不代表当前界面。

## 样本与共享模块

- `generate_import_fixtures.py` 生成原创导入样本，输出到被忽略的 `artifacts/import-validation/`。
- `plan_client.py`、`plan_helpers.mjs`、`local_import_helpers.mjs` 供检查脚本复用，不是独立命令。

原本绑定特定 Windows 虚拟环境的本机常规翻译启动器已移除。需要计算节点时，按[classic-engine 安装说明](../services/classic-engine/README.md)单独准备环境和模型。
