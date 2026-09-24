# Google Drive 顶层授权与选文件

Chrome、Edge、Firefox 统一使用同一 Web OAuth client：插件在独立的 1000 × 800 弹窗打开固定 HTTPS 连接页，再跳转到 `accounts.google.com` 完成授权和 Google 文件选择，返回同一窗口后由插件核验并导入。不再使用 Chrome `getAuthToken`、扩展 `oauth2` 配置或内嵌 Picker / GIS SDK。未配置连接页地址的构建关闭 Drive 入口。

首次进入连接页时点击“前往 Google 授权并选择文件”。账户经过 Drive API 核验后，插件记住本机连接选择；下次从插件进入云盘时自动跳转 Google，浏览器重启也保留此行为。取消授权会停留在连接页，允许手动重试，不自动反复跳转。主动断开连接会删除这项记录。自动跳转省去本站按钮，Google 页面仍按其登录与授权状态要求用户操作。

请求沿用 `response_type=token`、`trigger_onepick=true`、`prompt=consent select_account`、`allow_multiple=true`，仅申请 `drive.file`。读取已导入文件仍使用未过期的本机会话；过期或浏览器重启清空会话后提示重新连接，不在阅读期间自动弹出授权页。“切换 / 重新连接账户”入口完成 Google 选文件后只更新账户，不导入所选文件。

## 配置与构建

1. Google Cloud 项目启用 Google Drive API 与 Google Picker API，使用 **Web application** OAuth client。沿用已配置的 HTTPS JavaScript origin；完整连接页地址须登记为 **Authorized redirect URI**，正式地址为 `https://comics.nodelane.net/drive-connect/index.html`，不带 query / hash。
2. 在部署端的 `config.js` 只填写公开 `clientId`。无需 client secret、Chrome Extension client、API key 或 project number；实际配置不提交仓库。已废弃 `VITE_GOOGLE_CHROME_CLIENT_ID`。
3. 发布 `index.html`、`style.css`、`connect.js` 和实际 `config.js` 到固定 HTTPS 路径。沿用 `Cache-Control: no-store, no-transform`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: frame-ancestors 'none'`。页面 CSP 只允许自身脚本、样式和图片，不加载 Google SDK 或 iframe。页面不得加入广告、分析脚本或凭据日志。
4. 在 `apps/extension` 构建前设置 `VITE_DRIVE_CONNECT_URL` 为最终不跳转的完整 HTTPS 地址。构建仅增加连接页 origin 与 `www.googleapis.com` 的 host permissions；不要求 Google 登录页面的 host permission。普通 Vite 预览没有扩展安全桥，不能授权。

```powershell
$env:VITE_DRIVE_CONNECT_URL = 'https://comics.nodelane.net/drive-connect/index.html'
npm run zip
npm run zip:edge
```

页面共用官网的 [design-tokens.css](../../backend/website/public/design-tokens.css)，独立部署还须在根路径提供该文件、`icon-128.png` 与 `favicon.ico`。VPS 通过 [OpenResty 配置](../../deploy/openresty.comics.conf) 映射四个授权页文件；宿主机目录 `/opt/1panel/www/sites/comics-drive-connect/`，容器目录 `/www/sites/comics-drive-connect/`。公开文件权限 0644、目录 0755；实际目录与代理映射仍须在部署前核实。仅更新静态文件不需要重启 API。

OAuth consent 的测试用户、发布状态和品牌验证继续按现有 Google Cloud 配置管理。`drive.file` 权限也包含修改能力；本应用仅实现读取，不修改或删除云盘文件。

## 连接与凭据边界

`chrome.storage.local` 的 `nc-drive-connection:*` 只保存核验过的账户资料和连接代次，用于设置展示和再次进入时自动跳转；不保存 access token 或 refresh token。短期 token 留在可信 `chrome.storage.session`，到期或 session 清空后不能靠本地账户记录恢复凭据。初始连接页仅收到是否自动跳转的布尔提示，不再收到缓存 token。

OAuth 返回的短期 token 仅通过 URL **fragment** 临时到达本机；fragment 不随 HTTP 请求发送给网站。连接页立即用 `history.replaceState` 清理回调地址。网页 sessionStorage 只保存一次性 OAuth state、桥 nonce、截止时间和入口类型，不保存凭据；无服务端 token 交换或 refresh token。

后台逐项校验固定 origin / path、当前 tab、顶层 frame、documentId、一次性 nonce、期限与 OAuth state。离开连接页后旧文档失效，只有同一 tab 回到固定地址并清理回调 URL 才能注入新桥。后台重新取得 Drive `about.user.permissionId`、文件元数据与读取权限，不信任选文件页提供的账户标签或下载 URL。同一 token 不能通过重复返回延长有效期。

核验成功后串行保存账户记录、会话凭据与结果；断开、页面离开或关闭时撤销迟到写入，防止授权恢复。重复回调只能消费一次。选中文件后先结束桥再关闭弹窗；仅连接账户、取消或核验失败时保留窗口。

主动断开会删除自动跳转记录与本机会话，并取消在途授权；不删除云盘文件，也不撤销 Google 账户上的全部授权。Google 登录失效或远端撤权仍可能要求用户重新同意。

## 验证与支持范围

2026-09-24 用户已确认上一版 Edge 顶层流程可完成真实授权与导入。本次统一浏览器和自动跳转的回归与该次真实确认分别记录；不将模拟 Google 回调等同于真实 Google 长期授权或所有浏览器账户验收。

隔离浏览器回归入口见 [scripts/README.md](../../scripts/README.md)。脚本用全新 profile、本机 TLS / DNS 夹具模拟 Google 顶层授权及 Drive API，阻止第三方 Cookie，覆盖首次连接、再次自动跳转、取消、CBZ / MOBI 导入、位置恢复、失败、浏览器重启与断开；不读取用户 profile、真实账户或私有图片。

Google 顶层选择器展示的文件仍需插件核验。远程允许 CBZ/ZIP、未加密 MOBI，拒绝图片、快捷方式、Google 在线文档与文件夹；PDF / RAR 云端入口关闭，无整包下载回退或全盘扫描。MOBI 沿用通用模块的 MOBI6 / MOBI6+KF8 解析范围，不支持独立 KF8/AZW3、HUFF/CDIC 或 DRM。

协议参考：[Google 顶层 Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)、[JavaScript OAuth fragment 回调](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)、[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[Chrome session 存储](https://developer.chrome.com/docs/extensions/reference/api/storage)、[Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)、[Range 下载](https://developers.google.com/workspace/drive/api/guides/manage-downloads)。
