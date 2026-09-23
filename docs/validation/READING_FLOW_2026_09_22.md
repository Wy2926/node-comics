# 新来源基线的阅读计划浏览器回归

日期：2026-09-22。使用真实系统 Chrome、全新临时浏览器上下文与 `http://127.0.0.1:5176` 专用 Vite 来源。未读取用户书架、接入 Google Drive、调用真实翻译供应商或产生费用。

`tests/reader-fixture.ts` 保留原有模拟 API、受理回执、长轮询、延迟、离线、权益和下载失败场景；数据种子已改成 `reader-fixture-data.ts` 生成原创 PNG，经过实际 `importImageAlbum → chunked-idb-v1 → PageService`。不再依赖已删除的 `library/store`、`makeCopy` 或预存伪造原图摘要。计划统计通过 `client_item_id` 查页序；不再要求新客户端提交旧 `file_hash / page_index`。

| 脚本 | 实际通过的检查 |
| --- | --- |
| `verify_reading_plans.mjs` | 9 项：当前页优先与后三页预取、同图小滚动不重发、逐页滚动补位、旧任务仍运行时跳页受理、响应丢失核实同一操作、分钟限制不因任务完成提前解除、到期自动继续、空闲单个长轮询、单页显示时下载下一页已有译图 |
| `verify_reader_retry.mjs` | 6 项：立即显示重试中并禁连点、失败页仅提交一次且位置不变、下载失败复用已有结果、能力未加载时离线反馈、390px 简洁错误行、网络恢复手动重试立即继续 |
| `verify_history_removal.mjs` | 5 项：旧 / 未知 hash 规范回书架且保留 query、后退前进、账户导航、第 5 页重开恢复、原图模式空闲 2 分钟无历史 / 队列 / 翻译轮询且 focus 刷新权益 |

三次脚本均以退出码 0 完成，记录的页面运行异常为空。阅读计划样本记录 11 次计划请求，22 秒空闲区间只有 1 次增量长轮询。

本轮实际发现新 App 把未知 hash 显示为书架但没有规范 URL，现通过 `replaceState` 统一回 `#library`，保留查询参数。历史脚本中原图模式必须发起翻译增量轮询的旧断言也已替换：原图没有翻译窗口时不轮询；主动翻译的增量同步由阅读计划脚本单独验证。没有为通过检查恢复旧存储或旧接口。

复现：在 `apps/extension` 运行 `npx vite --host 127.0.0.1 --port 5176 --strictPort`，在仓库根目录配置已安装的 Playwright 与浏览器后执行：

```powershell
$env:PLAYWRIGHT_MODULE = '<已安装 playwright 模块的绝对路径>'
$env:TEST_CHROMIUM = '<Chrome 可执行文件绝对路径>'
node scripts/verify_reading_plans.mjs
node scripts/verify_reader_retry.mjs
node scripts/verify_history_removal.mjs
```

`PLAYWRIGHT_MODULE` 默认 `playwright`；未指定浏览器路径时使用已安装的 Playwright Chromium。脚本也接受原有 `CHROMIUM_PATH`，新文档统一使用 `TEST_CHROMIUM`。

脱敏输出与截图：[阅读计划结果](../../artifacts/reading-plans-validation/results.json)、[阅读计划截图](../../artifacts/reading-plans-validation/reading.png)、[重试结果](../../artifacts/reader-retry-validation/results.json)、[窄屏离线状态](../../artifacts/reader-retry-validation/offline-mobile.png)、[地址回退结果](../../artifacts/history-removal-validation/results.json)、[书架](../../artifacts/history-removal-validation/library.png)。这些运行产物被 Git 忽略，需执行脚本重新生成。

本项验证浏览器交互和模拟协议行为，不证明真实翻译质量、云端结算、扩展后台重启、Firefox runtime 或线上服务可用。完整源文件的扩展持久化验收见[主验收](SOURCE_ARCHITECTURE_2026_09_22.md)，长章节 DOM 窗口见[窗口验收](READER_WINDOW_2026_09_22.md)。
