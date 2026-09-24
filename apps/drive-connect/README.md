# Google Drive 授权与选文件页面

这是独立 HTTPS 静态连接页，不在扩展页加载远程 SDK。Chrome 可使用浏览器托管授权和嵌入式 Picker；Edge / Firefox 的网页连接使用 Google 顶层授权与选文件流程，完成后回到同一连接窗口，再由插件核验和导入。未设置页面地址的构建默认关闭 Drive 入口。

网页连接不加载 GIS / 嵌入式 Picker，不依赖本站跨站 iframe 中的 Google Cookie。请求使用 `trigger_onepick=true`、`prompt=consent select_account`、`allow_multiple=true`，仅申请 `drive.file`，每次新增选择都重新经过 Google 的选文件授权。已有文件的阅读仍复用未过期的本机会话，不会在阅读时弹出授权页。账号重新连接也需完成 Google 选文件步骤，但该入口只更新连接，不导入所选文件。

这是纯客户端 `response_type=token` 流程：无需 client secret，不引入服务端凭据交换或 refresh token 保存。Google 回调的短期 token 仅通过 URL **fragment** 暂时到达本机；连接页立即用 `history.replaceState` 清除 fragment，之后才恢复插件桥。fragment 不随 HTTP 请求发送给网站。会话状态只保存随机 state、桥 nonce、截止时间和入口类型，凭据不写入网页存储。依据：[Google 顶层 Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)、[JavaScript OAuth fragment 回调](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)。

本次已通过真实 Edge 153 的隔离浏览器回归：禁用第三方 Cookie，模拟 Google 顶层授权和回调，覆盖取消、账号连接、CBZ / MOBI 导入、位置恢复与失败反馈。新版网页脚本已部署美国 VPS，真实 Edge 禁用第三方 Cookie 后用新插件可通过线上入口进入真实 Google 登录页；2026-09-24 用户随后确认新流程已手动测试通过。该确认与模拟回归分别记录，不扩展为多账户、长期续期或其他浏览器真实授权均已验收。Chrome 托管模式的隔离 Chromium 回归也通过，包含模拟 Identity API 的浏览器重启恢复与断开。网站脚本和新版插件需配套更新；旧插件访问新版网页授权入口会提示更新。

插件在独立的 1000 × 800 弹出窗口中打开此页，不占阅读器所在主窗口的标签栏。关闭窗口会取消尚未完成的选择；授权桥仍按窗口内的 tab 与具体文档校验来源。

截至 2026-09-23，两种模式已通过模拟 Google 服务的隔离 Chrome 浏览器回归。此前用户确认网页授权后实际文件“已导入并能阅读”，本次交付后反馈当前流程恢复正常；真实账户重启恢复和长期续期尚未单独确认。模拟 Identity API 的成功不等于真实 Google 长期续期通过。

2026-09-24 发布配置使用固定地址 `https://comics.nodelane.net/drive-connect/index.html`，插件 0.1.1 写入该地址和既有 Chrome OAuth client。已核对 Web OAuth 来源包含正式域名，并将 Picker key 的网站限制设置为 `https://comics.nodelane.net/*` 与 `https://docs.google.com/*`，API 限定 Drive 与 Picker。部署及线上验证状态见 [VPS 部署记录](../../docs/VPS_DEPLOYMENT.md)。

## 配置与构建

页面与官网共用 [design-tokens.css](../../backend/website/public/design-tokens.css)，颜色、字体、描边、圆角、硬阴影与网点只在该文件维护；授权页的布局样式在 `style.css`。官网构建将令牌打入自身样式，并保留 `/design-tokens.css` 供独立授权页读取。VPS 独立发布授权页时，将该共享文件一同复制到授权页静态目录，由 OpenResty 的 `/design-tokens.css` 精确路由提供，无需为授权页重建 API；只复制授权页三个文件会缺少共享令牌。独立站点或本地夹具须将官网 `public` 中的 `design-tokens.css`、`icon-128.png`、`favicon.ico` 分别映射到根路径的同名文件，无需开放源码目录。授权桥、Google SDK 和选文件逻辑仍由原 `connect.js` 提供。

1. 在同一 Google Cloud 项目启用 Google Drive API 与 Google Picker API，创建 **Web application** 类型的 OAuth client。将选文件页的 HTTPS origin 登记为 Authorized JavaScript origin，例如 `https://example.com`，不带页面路径。同时将完整连接页地址登记为 **Authorized redirect URI**，正式地址为 `https://comics.nodelane.net/drive-connect/index.html`，不带 query / hash。不需要 client secret。仅申请 `https://www.googleapis.com/auth/drive.file`。
2. 填写页面 `config.js` 的公开 `clientId`、`apiKey`、`appId`。这里的 `clientId` 始终是 Web client；`appId` 是同项目的数字 **project number**，不是 project ID 或 extension ID。API key 设置 Websites 限制，添加选文件页的 `https://<host>/*` 与 `https://docs.google.com/*`；后者用于 Picker iframe，遗漏会导致 developer key 无效。API restrictions 限定 Google Picker API 和 Google Drive API。实际配置放在忽略文件或部署配置中，不提交仓库。
3. 将此目录发布到专用、无广告和分析脚本的 HTTPS 路径，例如 `https://example.com/drive-connect/index.html`。响应头使用 `Cache-Control: no-store`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: frame-ancestors 'none'`。页面只在 `style-src` 允许 Google SDK 所需的 inline CSS，`script-src` 仍限制为本页脚本和指定 Google SDK origin。不要记录 hash、postMessage 内容或 token。
4. 构建前设置 `VITE_DRIVE_CONNECT_URL` 为完整、最终不跳转的 HTTPS 页面 URL。构建会加入该 origin 与 `www.googleapis.com` 的 host permissions。普通 Vite 网页预览不提供扩展安全桥，不能授权。
5. Chrome 托管授权额外需要 **Chrome Extension** 类型 OAuth client，其注册的扩展 ID 必须匹配实际安装 ID。用扩展的稳定公钥 / 商店 ID 保持解压构建 ID 稳定，核对控制台登记后将该 client ID 配置为 `VITE_GOOGLE_CHROME_CLIENT_ID`。它与 Web client、Picker key / appId 使用同一 Google Cloud 项目。WXT 仅对 Chrome 构建写入 `oauth2.client_id` 和 `drive.file` scope；不要把 Chrome client 填进页面的 `config.js`。参见 [Chrome OAuth 配置](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth)。

现有 VPS 通过 [OpenResty 配置](../../deploy/openresty.comics.conf) 仅映射四个公开文件。宿主机目录为 `/opt/1panel/www/sites/comics-drive-connect/`，代理容器内为 `/www/sites/comics-drive-connect/`；目录权限 0755、公开文件 0644。复制 `index.html`、`style.css`、`connect.js`，并单独安装实际 `config.js`。不要把整个仓库或私密部署目录映射为网站目录。修改后先执行 OpenResty 配置检查，再 reload。

该路径额外返回 `Cache-Control: no-store, no-transform`，脚本声明 `data-cfasync="false"`，防止 Cloudflare Rocket Loader 改写脚本执行顺序和自动注入统计脚本。2026-09-24 已逐一核对四个公网资源与部署源内容一致。依据：[Cloudflare 内容改写](https://developers.cloudflare.com/rules/configuration-rules/response-body-inspection/)、[排除 Rocket Loader 脚本](https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/)。

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

`chrome.storage.local` 只保存用户允许自动恢复的账户和连接代次，不保存 access token 或 refresh token。短期 token 放在可信 `chrome.storage.session`；Chrome 模式对选文件桥发放 **5 分钟租约**，它不是 Google token 的真实到期时间。浏览器重启清空 session 后，已保存且未断开的 Chrome 连接可再次向 Chrome 静默取得凭据，不把 session 丢失直接当作需要用户重新授权。网页模式受 OAuth 短期 token 限制，过期或 session 丢失后需用户点击连接；没有业务后端 refresh token。[Chrome session 存储](https://developer.chrome.com/docs/extensions/reference/api/storage)。

页面仅在固定 HTTPS origin / path、当前 tab、顶层 frame、documentId、一次性 nonce 和期限均核验后取得本次会话。Chrome 桥与 SDK 就绪且有有效 token 时，**自动打开一次 Picker**；取消只取消选文件，可再次选择，不撤销 Chrome 连接。“切换 / 重新连接账户”由用户主动点击后才走顶层网页授权，并明确说明这是临时网页连接；Chrome 租约过期时主按钮提示返回插件重新打开，不悄然切换授权方式。网页授权的往返由后台持久会话跟踪：离开原页面时废止旧文档，只有同一 tab 返回固定页面、清理回调 URL 后才能注入新桥；返回结果还必须匹配 OAuth state。重复返回、过期、断开和迟到写入不能恢复旧授权。

选中文件并通过后台核验后，插件先保存选择结果、结束安全桥，再自动关闭选文件弹窗，阅读器继续导入。取消选择、仅连接账户或核验失败时保留弹窗。

选文件结果仍由后台重新核验账户、文件元数据和读取权限，不信任 Picker 下载 URL。同一凭据的往返不能自行延长网页授权期限或改变连接代次。除上述立即清除的 OAuth fragment 外，token 不进入任何 URL、日志、漫画数据库、网页存储或同步存储；仅专用桥和当前可信授权页短暂接触它，漫画网站脚本不接触凭据。

断开会持久删除自动连接记录，并清理本机凭据缓存；即使 Chrome 仍保留 Google grant，后台也不能自行恢复已断开的连接。断开不是删除云盘文件或撤销 Google 账户上全部授权。Chrome 登录退出、远端撤权、测试授权到期等情况仍可能需要用户重新连接，不能承诺永久免授权。

## 本地验收

临时 HTTPS 服务配置、Cloudflare 隧道工具和记录位于被忽略的 `artifacts/drive-connect-local/`。只读服务仅映射选文件页的四个资源，不映射目录或仓库；实际 `config.js` 与源码占位配置分开。临时隧道地址随重启变化，重启后需重新核对 Google origin 和 API key 网站限制，不能作为生产固定 URL。

隔离回归入口与两种授权模式命令见 [scripts/README.md](../../scripts/README.md)。脚本新建 profile，用本机 TLS / DNS 夹具模拟 Google 服务和 Chrome Identity API，不访问用户 profile、真实账户或私有图片。真实验收仍需分别覆盖目标浏览器的首次同意、顶层选文件回调、重启后的读取、Google 凭据更新、多账户、撤权和断开；模拟回归不替代这些检查。Edge 实测时须移除之前添加的本站第三方 Cookie 例外，且保持第三方 Cookie 阻止开启，确认不用例外也能完成选择和导入。

远程允许 CBZ/ZIP、未加密 MOBI 漫画文件，不支持图片。MOBI 沿用本地 MOBI6 / MOBI6+KF8 解析范围，不支持独立 KF8/AZW3、HUFF/CDIC 或 DRM；记录索引与逐页解析由通用格式模块负责，Drive 驱动只提供经权限和版本核验的范围字节。快捷方式、Google 在线文档、文件夹直接拒绝；PDF / RAR 云端入口关闭，没有整包回退或全盘扫描。

Picker 不设置 [MIME 过滤](https://developers.google.com/workspace/drive/picker/reference/picker.view.setmimetypes)，避免 Google 标为未知或其他 MIME 的 MOBI 被隐藏；显示文件夹供逐层浏览，但禁止将文件夹本身作为导入结果，不递归导入整目录。列表中的文件可见不代表支持导入：扩展只接受已核验元数据中的 `.cbz` / `.zip` / `.mobi`，拒绝图片 MIME、Google 在线文档和文件夹，并由格式模块验证文件内容后才发布漫画。

Picker 配置和读取协议依据：[Picker key 限制](https://developers.google.com/workspace/drive/picker/guides/web-picker)、[Picker 同项目配置](https://developers.google.com/workspace/drive/picker/guides/web-picker-sample)、[Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)、[Range 下载](https://developers.google.com/workspace/drive/api/guides/manage-downloads)、[资源密钥](https://developers.google.com/workspace/drive/api/guides/resource-keys)。
