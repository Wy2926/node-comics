# Google Drive 授权与选文件页面

这是独立 HTTPS 静态页面源码，承载 Google Picker 和网页授权，不在扩展页加载远程 SDK。Chrome 可使用浏览器托管授权，Edge / Firefox 保留 GIS token model；两种方式都需要此选文件页面。未设置页面地址的构建默认关闭 Drive 入口。

截至 2026-09-23，两种模式已通过模拟 Google 服务的隔离 Chrome 浏览器回归。此前用户确认网页授权后实际文件“已导入并能阅读”，本次交付后反馈当前流程恢复正常；真实账户重启恢复和长期续期尚未单独确认。模拟结果、用户反馈和未验证范围见 [Drive 授权回归](../../docs/validation/DRIVE_AUTH_2026_09_23.md)，不能把模拟 Identity API 成功写成真实 Google 长期续期成功。没有生产部署或由代理修改 Google Cloud 资源。

## 配置与构建

1. 在同一 Google Cloud 项目启用 Google Drive API 与 Google Picker API，创建 **Web application** 类型的 OAuth client。将选文件页的 HTTPS origin 登记为 Authorized JavaScript origin，例如 `https://example.com`，不带页面路径。页面使用 `initTokenClient` 弹窗和 JavaScript callback，不需要 redirect URI 或 client secret。仅申请 `https://www.googleapis.com/auth/drive.file`。
2. 填写页面 `config.js` 的公开 `clientId`、`apiKey`、`appId`。这里的 `clientId` 始终是 Web client；`appId` 是同项目的数字 **project number**，不是 project ID 或 extension ID。API key 设置 Websites 限制，添加选文件页的 `https://<host>/*` 与 `https://docs.google.com/*`；后者用于 Picker iframe，遗漏会导致 developer key 无效。API restrictions 限定 Google Picker API 和 Google Drive API。实际配置放在忽略文件或部署配置中，不提交仓库。
3. 将此目录发布到专用、无广告和分析脚本的 HTTPS 路径，例如 `https://example.com/drive-connect/index.html`。响应头使用 `Cache-Control: no-store`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: frame-ancestors 'none'`。页面只在 `style-src` 允许 Google SDK 所需的 inline CSS，`script-src` 仍限制为本页脚本和指定 Google SDK origin。不要记录 hash、postMessage 内容或 token。
4. 构建前设置 `VITE_DRIVE_CONNECT_URL` 为完整、最终不跳转的 HTTPS 页面 URL。构建会加入该 origin 与 `www.googleapis.com` 的 host permissions。普通 Vite 网页预览不提供扩展安全桥，不能授权。
5. Chrome 托管授权额外需要 **Chrome Extension** 类型 OAuth client，其注册的扩展 ID 必须匹配实际安装 ID。用扩展的稳定公钥 / 商店 ID 保持解压构建 ID 稳定，核对控制台登记后将该 client ID 配置为 `VITE_GOOGLE_CHROME_CLIENT_ID`。它与 Web client、Picker key / appId 使用同一 Google Cloud 项目。WXT 仅对 Chrome 构建写入 `oauth2.client_id` 和 `drive.file` scope；不要把 Chrome client 填进页面的 `config.js`。参见 [Chrome OAuth 配置](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)。

在 `apps/extension` 目录构建的示例，所有值均为占位符：

```powershell
$env:VITE_DRIVE_CONNECT_URL = 'https://example.com/drive-connect/index.html'
$env:VITE_GOOGLE_CHROME_CLIENT_ID = '<Chrome Extension OAuth Client ID>'
npm run build
```

不设置 `VITE_GOOGLE_CHROME_CLIENT_ID` 时，Chrome 同样使用网页授权。Edge 会被明确排除出 Chrome 托管策略；Firefox 缺少 `getAuthToken`，也使用网页授权，不能因存在部分 `identity` API 就假定可用。[Edge API 支持](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)。

OAuth consent 的 Audience 若为 External / Testing，须把验收账户加入 Test users，并遵守 Google 的测试授权期限；它与单个 access token 的有效期不同。面向公开用户前切到 In production，并按控制台完成品牌、域名和适用的验证要求。`drive.file` 属于 non-sensitive scope，但权限本身也允许修改所选文件；当前应用只实现读取，不请求全盘访问，不修改或删除云盘文件。[OAuth 测试限制](https://support.google.com/cloud/answer/15549945?hl=en)、[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

## 连接与凭据边界

Chrome 配置有效时，用户点击插件 Drive 入口才允许 `getAuthToken({interactive: true})`。读取漫画始终用非交互请求，由 Chrome 的 token 缓存处理过期；需要登录或重新同意时返回重连提示，不在阅读期间弹授权窗口。Google 账户用 Drive `about.user.permissionId` 核对，不能把 Chrome profile 邮箱当作漫画绑定账户。失效凭据只做一次移除缓存后的静默重取，账户不匹配、权限不足或离线不会盲目重新授权。[Chrome Identity](https://developer.chrome.com/docs/extensions/reference/api/identity)。

`chrome.storage.local` 只保存用户允许自动恢复的账户和连接代次，不保存 access token 或 refresh token。短期 token 放在可信 `chrome.storage.session`；Chrome 模式对选文件桥发放 **5 分钟租约**，它不是 Google token 的真实到期时间。浏览器重启清空 session 后，已保存且未断开的 Chrome 连接可再次向 Chrome 静默取得凭据，不把 session 丢失直接当作需要用户重新授权。网页模式仍受 GIS 短期 token 限制，过期或 session 丢失后需用户点击连接；没有业务后端 refresh token。[Chrome session 存储](https://developer.chrome.com/docs/extensions/reference/api/storage)、[GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)。

页面仅在固定 HTTPS origin / path、当前 tab、顶层 frame、documentId、一次性 nonce 和期限均核验后取得本次会话。桥与 SDK 就绪且有有效 token 时，**自动打开一次 Picker**；取消只取消选文件，可再次选择，不撤销 Chrome 连接。“切换 / 重新连接账户”由用户主动点击后才走 GIS，并明确说明这是临时网页连接；Chrome 租约过期时主按钮提示返回插件重新打开，不悄然切换授权方式。

选文件结果仍由后台重新核验账户、文件元数据和读取权限，不信任 Picker 下载 URL。同一凭据的往返不能自行延长网页授权期限或改变连接代次。token 不进入 URL、日志、漫画数据库、localStorage 或同步存储；仅专用桥和当前可信授权页短暂接触它，漫画网站脚本不接触凭据。

断开会持久删除自动连接记录，并清理本机凭据缓存；即使 Chrome 仍保留 Google grant，后台也不能自行恢复已断开的连接。断开不是删除云盘文件或撤销 Google 账户上全部授权。Chrome 登录退出、远端撤权、测试授权到期等情况仍可能需要用户重新连接，不能承诺永久免授权。

## 本地验收

临时 HTTPS 服务配置、Cloudflare 隧道工具和记录位于被忽略的 `artifacts/drive-connect-local/`。只读服务仅映射选文件页的四个资源，不映射目录或仓库；实际 `config.js` 与源码占位配置分开。临时隧道地址随重启变化，重启后需重新核对 Google origin 和 API key 网站限制，不能作为生产固定 URL。

隔离回归入口与两种授权模式命令见 [scripts/README.md](../../scripts/README.md)。脚本新建 profile，用本机 TLS / DNS 夹具模拟 Google 服务和 Chrome Identity API，不访问用户 profile、真实账户或私有图片。真实验收仍需分别覆盖目标浏览器的首次同意、重启后的读取、Google 凭据更新、多账户、撤权和断开；模拟回归不替代这些检查。

首轮远程仅允许 CBZ/ZIP 漫画文件，不支持图片。快捷方式、Google 在线文档、文件夹直接拒绝；PDF / MOBI / RAR 云端入口关闭，没有整包回退或全盘扫描。

Picker 配置和读取协议依据：[Picker key 限制](https://developers.google.com/workspace/drive/picker/guides/web-picker)、[Picker 同项目配置](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample)、[Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)、[Range 下载](https://developers.google.com/workspace/drive/api/guides/manage-downloads)、[资源密钥](https://developers.google.com/workspace/drive/api/guides/resource-keys)。
