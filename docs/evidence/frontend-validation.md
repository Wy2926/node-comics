# 前端构建与契约验证

时间：2026-09-13，Windows / Node.js 22.23.2。实际浏览器截图与真实 MOBI / AI 图片效果由同目录的根任务验收材料单独记录，本文件不把单元测试当作视觉验收。

## 最终命令

在 `apps/extension` 执行：

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | 通过，WXT 类型生成和 TypeScript 严格检查 |
| `npm test` | 5 个文件、27 个测试通过 |
| `npm run build` | Chrome MV3 扩展构建通过，解压目录约 3.23 MB |
| `npm run build:web` | Vite Web 阅读器构建通过，主 JS 308.98 kB，gzip 99.23 kB |
| `npm run zip` | 构建与 ZIP 成功，2,945,830 字节 |
| `npm audit --omit=dev` | 0 个漏洞 |
| `npm audit` | 3 个 high，0 critical；仅开发工具链 |

实际安装版本：React / React DOM 19.3.0，WXT 0.21.4，Vite 7.3.6，Vitest 5.0.0。版本固定在 `package-lock.json`，安装命令与 npm peer 解析说明见 `apps/extension/README.md`。

## 测试范围

- 4 个阅读模型与来源 URL 边界测试：100 页有限窗口、页内比例、自然排序、危险协议与凭据 URL 拒绝。
- 6 个 MOBI 解析测试：由 `src/importers/mobi.test.ts` 记录，不在浏览器执行书内 HTML。
- 11 个 OIDC 测试：Web / 扩展 PKCE 流程、S256、state / origin / path / TTL、一次性授权上下文、身份服务错误、后端拒绝令牌、HTTPS，以及授权期间服务地址变化时保留令牌原属 origin。全部使用隔离 mock，尚不等于真实 IdP 验收。
- 4 个本地数据测试：缓存淘汰同步清理资源映射、跨服务令牌隔离、另一标签页写旧章节时保持独立阅读锚点、旧标签页写入不会丢失新任务 ID。
- 2 个提交恢复测试：报价明确过期 / 配置改变后允许重新估价；网络未知结果、上游未知和幂等冲突继续保留同一操作记录。

## 打包权限与恢复边界

最终打包 manifest 的必选 host 权限仅为 `http://127.0.0.1:18088/*` 与 `http://localhost:18088/*`。HTTP / HTTPS 网页权限在 `optional_host_permissions`，通过明确操作逐域申请。Content script 不声明广泛 matches，避免 WXT 把运行时 matches 自动提升为必选网站权限。

扩展消息只接受自身 runtime ID 与扩展 URL；独立扩展阅读标签页可以通信，网页 content sender 无法调用图片协调接口。来源获取核对已登记图片 ID、来源 URL 与 document navigation nonce，包括右键入口。

阅读锚点保存在每章独立 `nc-position` 小记录，只由阅读导航写入。任务同步不写这一记录；章节任务列表在 IndexedDB 事务中合并，避免其他标签页的旧快照覆盖新提交的任务 ID。创建任务前重新读取持久状态；提交前保存报价 / 幂等键 / 账户 / 服务 origin，任务 ID 落地后才清除待核实操作。

## 依赖审计限制

`web-ext → addons-linter → image-size 2.0.2` 的开发图像解析链有 3 个 high 条目。此次 npm 查询 `image-size` 最新版仍为 2.0.2，未通过不兼容版本降级或忽略审计来声明已修复。它们不进入生产阅读器 bundle；完整脱敏结果分别保存在 `frontend-audit.json` 和 `frontend-audit-production.json`。

## 最终构建产物

- 扩展目录：`apps/extension/.output/chrome-mv3/`
- Web：`apps/extension/dist-web/`
- ZIP：`apps/extension/.output/node-comicsextension-0.1.0-chrome.zip`
- ZIP SHA-256：`B16BBE5C8A5ACAF004BDB436938D2D7E6FD35FF28BCAB3BE1CC7F74489309891`

这些是本地构建产物，不代表扩展商店上架或公开部署。
