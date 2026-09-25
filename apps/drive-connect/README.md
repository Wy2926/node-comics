# Google Drive 连接页

Chrome、Edge、Firefox 共用 HTTPS 连接页与 Web OAuth client，跳转 Google 完成授权和文件选择，再由插件核验账户与文件。

## 配置

1. 在 Google Cloud 启用 Drive API、Picker API，创建 Web application OAuth client，将连接页完整地址登记为 Authorized redirect URI。
2. 在部署副本的 [config.js](config.js) 中填写公开 `clientId`；无需 client secret。
3. 部署 `index.html`、`style.css`、`connect.js`、`config.js`，并提供根路径的 `design-tokens.css`、`icon-128.png` 和 `favicon.ico`。代理模板见 [openresty.comics.conf](../../deploy/openresty.comics.conf)。
4. 在插件构建前设置 `VITE_DRIVE_CONNECT_URL=https://comics.nodelane.net/drive-connect/index.html`。未配置时关闭 Drive 入口；授权需在实际扩展中验证。

## 协议规范

- 使用 `response_type=token`、`trigger_onepick=true`、`prompt=consent`、`allow_multiple=true` 和 `drive.file`。唯一已核验账户使用邮箱 `login_hint`；仅主动切换账户时使用 `select_account`。保留 Google 要求的 consent。
- 首次手动进入 Google；记住本机连接后再次进入自动跳转。取消后允许手动重试；只连接账户时不导入所选文件。远程格式限 CBZ/ZIP、未加密 MOBI，具体限制见[格式规范](../../docs/IMPORT_FORMATS_AND_CACHE.md)。
- `storage.local` 只保存已核验账户和连接代次；短期 token 留在可信 `storage.session`。OAuth token 从 fragment 返回后立即清理 URL；连接页 sessionStorage 仅保留一次性状态，不保存凭据。
- 桥校验固定 origin/path、tab、顶层 frame、documentId、nonce、期限和 OAuth state；后台重新读取 Drive 账户与文件元数据。回调只消费一次，断开或导航撤销迟到写入。
- 连接页只加载本地资源，禁止广告、统计和凭据日志。使用 no-store、nosniff 与禁止嵌入的 CSP；源站凭据不上送后端。`drive.file` 包含修改能力，但本应用只读取文件。

隔离回归运行 `node scripts/verify_drive_import.mjs`，环境见[脚本入口](../../scripts/README.md#来源与阅读验收)。它模拟 Google 与 Drive；真实授权需按目标浏览器单独检查。

协议依据：[顶层 Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)、[OAuth fragment 回调](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)、[Drive 权限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。
