# Drive 授权复用与 Chrome 托管连接（2026-09-23）

此前已修复 Drive 消息回传和原生 fetch 调用问题，用户确认网页授权后的文件“已导入并能阅读”，随后反馈仍需反复授权。此前 GIS token model 只能复用会话内未过期凭据，不能提供浏览器重启后的自动恢复。本次增加可选 Chrome 托管授权，并让已有连接直接打开 Picker；未引入业务后端 refresh token。

## 已实现边界

- Chrome 构建通过 `VITE_GOOGLE_CHROME_CLIENT_ID` 使用 Chrome Extension OAuth client；manifest 的稳定扩展 ID 已核对匹配用户配置，`oauth2` 只申请 `drive.file`。用户点击 Drive 入口才允许交互式 `getAuthToken`，阅读始终非交互，由 Chrome 缓存处理凭据过期。不能静默取得时返回重连提示。[Chrome OAuth](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)、[Chrome Identity](https://developer.chrome.com/docs/extensions/reference/api/identity)。
- Edge 明确排除 Chrome 策略，Firefox 无 `getAuthToken` 时使用 GIS 短期授权；两种模式都需要 HTTPS Picker 页面、Web client、同项目 API key / project number。网页连接不承诺跨重启或长期免授权。[Edge API 支持](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)、[GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)。
- 账户由 Drive `about.user.permissionId` 核对。`storage.local` 只保存账户和连接代次，没有任何 token；可信 `storage.session` 保存短期凭据。Chrome 给 Picker 的 5 分钟期限是桥租约，不是 Google token 的到期时间。会话清空后，未断开的 Chrome 连接可非交互恢复。
- 桥、SDK 和有效 session 都就绪时自动打开一次 Picker，取消后可再次选择；取消选择不撤销 Chrome 连接。副按钮“切换 / 重新连接账户”明确提示临时网页授权，只有用户点击才调用 GIS。Chrome 租约失效时要求回插件重开，不自动切换认证方式。
- 显式断开持久移除自动恢复记录和本机凭据缓存；即使 Chrome 仍有 Google grant，后台也不能恢复已断开的连接。账户切换、导航取消、断开和并发写入继续用连接代次与提交检查隔离；token 不进入 URL、日志、漫画数据库、localStorage 或同步存储。

## 自动化与构建

最终全量检查：**53 个测试文件通过、1 个跳过；540 项通过、1 项规模测试按常规配置跳过**。`npm run check` 的 TypeScript 与 183 个模块检查通过，Chrome MV3 构建通过。定向回归包含 Chrome 授权 helper 33 项、会话与并发边界 39 项、选文件页 17 项。

`scripts/verify_drive_import.mjs` 在 Chrome for Testing **141.0.7390.37** 的新建 profile 中运行，使用本机 TLS / DNS、自制 640×960 图片、模拟 Google 服务与模拟 Chrome Identity API；没有访问真实账户或云盘。

| 模式 | 最终证据目录 | 结果 |
| --- | --- | --- |
| Chrome 托管策略模拟 | `artifacts/source-architecture/drive/run-4Db5B3/` | 7 项检查通过；模拟 grant 1 次、GIS 0 次、Picker 2 次、非交互取凭据 10 次 |
| GIS 网页策略模拟 | `artifacts/source-architecture/drive/run-1RZk4k/` | 5 项检查通过；GIS 1 次、Picker 2 次 |

两种模式都覆盖插件按钮、安全桥、文件名确认、登记后 Range 读图、重复选择和导入失败可见提示，均无页面异常、未授权请求或“不支持的操作”回复。Chrome 模式额外真实关闭并重开隔离浏览器，确认 session 清空、本地连接记录保留、通过模拟非交互 Identity API 恢复，随后断开不能再恢复。`results.json` 与 `selection.png`、`reader.png`、`import-error.png` 位于对应忽略目录；已检查原图和错误弹窗截图。

这里的浏览器重启是真实进程重启，Google grant 和续期响应是模拟数据，不能据此报告真实 Google 长期续期已通过。配置、客户端 ID、API key、临时域名和凭据未写入本记录。

## 用户反馈与尚未验证范围

用户已协调测试 origin 和 API key 网站限制。新构建交付后，用户先反馈选文件后出现 `invalid-bridge`，随后明确反馈“现在好了，没事了”；没有继续复现或定位该次短暂错误，不能推测其原因。这确认当前实际流程已恢复正常，但不证明真实账户的浏览器重启、长时间 token 过期、多账户、远端撤权和版本变化全部通过。

前一日用户确认真实网页授权后的导入和阅读，详见 [Drive 导入回归](DRIVE_IMPORT_2026_09_22.md)。本次不把该反馈当作新增 Chrome 托管策略的完整验收。没有 Git 提交、商店发布或生产部署；网站导入仍由网站页面内嵌按钮触发。
