# 脚本入口

从仓库根目录执行。脚本按不同依赖和验证边界保留；同一工具不在多份历史实施记录中重复维护启动方法。

## 运行与运维

| 入口 | 用途与前提 |
| --- | --- |
| `bootstrap.ps1` | 生成本地控制服务配置；`-Start` 启动 Docker，`-Production` 使用独立生产配置。见[后端说明](../backend/README.md) |
| `database_backup.py` / `verify_database_restore.py` | 数据库备份与新库恢复演练。连接、隔离校验、PostgreSQL 客户端要求见[运维说明](../docs/OPERATIONS.md) |
| `export_openapi.py` | 从当前后端导出机器契约，见[契约说明](../contracts/README.md) |
| `paddle_sandbox_server.py` | 隔离支付沙盒；只允许 checkout/webhook 入口通过隧道公开，见[Paddle 接入](../docs/PADDLE_BILLING_DESIGN.md) |

Python 脚本需准备 `backend/requirements.txt` 中的依赖；仓库不附带已安装的虚拟环境。默认后端回归使用[测试 Compose](../deploy/compose.tests.yaml)，不读取产品环境文件。单独运行运维工具前，按对应文档准备其配置。

## 验证工具

| 工具 | 验证边界 |
| --- | --- |
| `verify_reading_api.mjs` | 临时 API、worker、合成供应商与浏览器的完整阅读链路 |
| `verify_reading_plans.mjs` / `verify_reader_retry.mjs` / `verify_history_removal.mjs` | 模拟接口下的阅读窗口、限流、恢复，以及旧历史页地址回退和无历史轮询；Vite 端口 5176 |
| `verify_membership_admin.mjs` | 隔离后台的赠送与分钟配置 |
| `verify_inline_translation.mjs` / `verify_popup.mjs` / `verify_web_import.mjs` / `verify_acquisition_order.mjs` | 构建后的 MV3 扩展与隔离网页，覆盖原位翻译、弹窗、发现及采集顺序 |
| `verify_local_import.mjs` / `verify_comic_import.mjs` / `verify_library.mjs` / `verify_comic_export.mjs` | 本地导入、作品管理与导出；先生成夹具，端口和模式见各脚本头部 |
| `verify_extension_theme.mjs` | 插件桌面页面视觉与交互、亮暗主题、表单和副本操作；Vite 端口 5176、5175、5186，见[共享视觉令牌](../docs/POPUP_AND_THEME.md#本地验证) |
| `verify_mangacopy.mjs` | MangaCopy 适配检查，详见[来源设计](../docs/MANGACOPY_LIBRARY_DESIGN.md) |
| `verify_r2_download.mjs` | 模拟 R2 响应下的浏览器下载与权限处理，不访问 Cloudflare |
| `verify_cluster_r2.py` / `probe_r2.py` | 真实 R2 接入；运行前阅读脚本中的对象范围与清理规则，不作为普通离线回归 |
| `smoke_api.py` | 默认检查 API；`--translate` 会发起真实付费图片请求，保存操作编号以便核实与恢复，不自动重建未知请求 |

浏览器脚本需要 Node.js、已安装的 Playwright 和对应浏览器；`PLAYWRIGHT_MODULE` 可指向已有模块。脚本使用各自的隔离端口、夹具或扩展配置，并非所有工具支持相同环境变量。阅读与后台检查的完整启动顺序见[阅读契约验收](../docs/READING_TRANSLATION_CONTRACT.md#10-实现与验证记录)。模拟图片只能验证交互，不能证明翻译效果。

## 样本与共享模块

- `generate_import_fixtures.py` 生成原创导入样本，输出到被忽略的 `artifacts/import-validation/`。
- `inspect_mobi.mjs` 读取本机 `临时资源/` 下的 MOBI 并输出解析统计；没有私有样本时不能运行。真实格式记录见[技术验证](../docs/TECH_RESEARCH.md)。
- `plan_client.py`、`plan_helpers.mjs`、`local_import_helpers.mjs` 供检查脚本复用，不是独立命令。

原本绑定特定 Windows 虚拟环境的本机常规翻译启动器已移除。需要计算节点时，按[classic-engine 安装说明](../services/classic-engine/README.md)单独准备环境和模型。
