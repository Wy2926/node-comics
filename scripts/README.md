# 脚本入口

从仓库根目录执行。Python 工具按[后端](../backend/README.md)安装依赖；浏览器工具需要 Node.js、Playwright 和支持解压扩展的 Chromium。脚本启动条件以下表和文件内配置为准，结果写入忽略的 `artifacts/`。

## 运行与运维

| 入口 | 用途 |
| --- | --- |
| `bootstrap.ps1` | 本地控制服务初始化与启动，见[后端](../backend/README.md) |
| `database_backup.py` / `verify_database_restore.py` | [备份与隔离恢复](../docs/OPERATIONS.md) |
| `export_openapi.py` | [导出 API 契约](../contracts/README.md) |
| `upload_extension_release.py` | 校验、上传安装包，见[部署规范](../docs/DEPLOYMENT.md) |
| [remove-obsolete-artifacts.ps1](remove-obsolete-artifacts.ps1) | Windows 清理旧测试、报告与重建产物；默认预览，`-Apply` 执行，保留当前发布包、营销图片与节点资料 |

清理命令：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remove-obsolete-artifacts.ps1`。确认清单并关闭测试／构建后追加 `-Apply`；旧节点测试目录访问被拒绝时，改用管理员 PowerShell。范围固定在仓库三处 artifacts 下，不跟随目录链接，不删除 Git 跟踪内容或清单外路径。隔离测试：`python scripts/tests/test_artifact_cleanup.py`。

## 来源与阅读验收

先构建插件，并生成自制导入样本；可复用的原创图片见[样本说明](../samples/README.md)。样本工具需要 Pillow、ReportLab；TLS 网站／Drive 夹具另需 Python cryptography。

```powershell
python scripts/generate_import_fixtures.py
npm --prefix apps/extension run build
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<支持加载解压扩展的浏览器可执行文件>'
$env:TEST_BROWSER_NAME = 'chrome-extension'
node scripts/verify_simple_reading.mjs
```

未设置路径时使用脚本默认 Playwright／浏览器。原位翻译脚本使用 `CHROMIUM_PATH`；各脚本支持的变量以源码为准。默认使用隔离 profile 和自制样本，真实网络工具在表中单列。

| 工具 | 检查范围 |
| --- | --- |
| `verify_simple_reading.mjs` / `verify_source_database_baseline.mjs` | 单来源导入、格式、书架、批量移除、新库和重启恢复 |
| `verify_source_export.mjs` / `verify_website_source_lifecycle.mjs` | 导出、网站导入、按需读取与主动下载 |
| `verify_catalog_sync.mjs` / `verify_source_covers.mjs` | 目录更新、失败保留与封面；后者 `RUN_LIVE_COVERS=1` 读取公开来源 |
| `verify_image_transport.mjs` / `verify_source_image_cache.mjs` | [公共取图](../docs/IMAGE_ACCESS.md)、权限、Referer、重定向与缓存重试 |
| `verify_drive_import.mjs` | 模拟 Google／Drive 的连接、导入、重启与撤权；构建需配置连接页，`TEST_DRIVE_FORMAT=mobi` 切换 MOBI 样本 |
| `verify_login_popup.mjs` | 模拟 OIDC、PKCE、取消、失败重试与登录后阅读恢复 |
| `verify_inline_translation.mjs` / `verify_popup.mjs` | 原位翻译与弹窗；各站点真实网络开关见[站点说明](../docs/SITE_ADAPTERS.md#现有站点) |
| `verify_chapter_imports.mjs` | 真实 DM5／Comic PASH 裸章节归属与完整目录 |
| `verify_comicpash.mjs`、站点 `tests/verify-*.mjs` | 站点协议与浏览器流程，环境及网络范围见各站点 README |
| `verify_reading_translations.mjs` / `verify_reader_retry.mjs` / `verify_history_removal.mjs` | Vite 5176 模拟阅读器、分钟退避、恢复与重试 |
| `verify_reading_api.mjs` | 临时 API／worker 与合成供应商，启动顺序见[翻译契约](../docs/READING_TRANSLATION_CONTRACT.md#9-验证入口) |
| `verify_translation_channels.mjs` / `verify_translation_channel_host.mjs` | 渠道设置、模拟 MTU、后台中断与缓存，见[渠道规范](../docs/TRANSLATION_CHANNELS.md#验证) |
| `verify_translation_channel_live.mjs` | 真实回环 MTU；使用 `MTU_USERNAME`、`MTU_PASSWORD`、可选 `MTU_BASE_URL`，实际调用服务端引擎 |
| `verify_reader_directory.mjs` | Vite 5181 的目录夹具；同端口 `reader-window-fixture.html` 检查有限图片窗口 |
| `verify_extension_theme.mjs` | Vite 5175 或 `TEST_READER_URL`，主题、菜单与位置恢复 |
| `verify_membership_admin.mjs` / `verify_admin_completion.mjs` | 会员、赠送与管理操作，见[后台验收](../docs/ADMIN_CONSOLE.md#验证) |
| `verify_r2_download.mjs` | 模拟 R2 下载与权限 |
| `verify_cluster_r2.py` / `probe_r2.py` | 真实 R2；按脚本说明配置对象范围和清理规则 |
| `smoke_api.py` / `verify_image_provider_live.py` | API／真实图片供应商；`smoke_api --translate` 才发起付费翻译，未知请求先核实 |

Drive 可用 `TEST_EXTENSION_DIR` 指向 Edge 构建并配套 `TEST_CHROMIUM`；授权页、Google 与 Drive 均由本机 TLS 模拟，真实 Google 授权另验。登录生命周期夹具使用 Vite 5187 的 `auth-lifecycle-fixture.html`；订阅焦点夹具使用 Vite 5192 的 `billing-focus-fixture.html`。

## 官网验收

在 `backend/website` 启动开发或构建预览服务。脚本使用本机 Chrome 和 Playwright，可设置 `PLAYWRIGHT_MODULE`、`WEBSITE_PREVIEW_URL`：

| 工具 | 范围 |
| --- | --- |
| `verify_website_download.mjs` | 五语下载页；指向公开服务时真实下载并核对摘要 |
| `verify_website_pricing.mjs` | 模拟报价、月年付切换、加载与失败 |
| `verify_website_compare.mjs` | 四种图片、切换、加载失败与恢复 |
| `verify_website_account.mjs` | 先在官网目录运行 `npx vite --config tests/account-fixture.config.ts`，固定 5193；模拟账户、订阅与退出 |

完整同源账户流程见[官网 README](../backend/website/README.md)。模拟响应验证交互，真实身份、付款和模型效果分别验证。

## 辅助工具

`probe_page_image_access.mjs` 使用临时研究扩展比较图片像素、原始字节和浏览器缓存；可选 `PROBE_DEBUGGER`、`PROBE_PAGE_CAPTURE`、`PROBE_REQUEST_CONTEXT` 仅影响实验扩展，不改变产品权限。

`translation_client.py`、`local_import_helpers.mjs` 是脚本共享模块；`generate_import_fixtures.py` 只生成自制样本。脚本使用的数据、profile 和结果不提交仓库。
