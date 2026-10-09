# 生产身份配置与验证

后端默认 `APP_ENV=production`。生产启动校验要求 `DEV_AUTH=false`、PostgreSQL、完整 OIDC 配置、可写的私有文件目录，以及明确的网页来源或固定扩展 ID。任何一项缺失会在连接数据库、迁移和启动服务之前失败。免密码开发管理员登录仅在显式 `APP_ENV=development` / `test` 且配置至少 32 字符签名密钥时可用。

生产部署使用 [服务器 Compose](../deploy/compose.server.yaml)，应用配置从 [deploy/.env.server.example](../deploy/.env.server.example) 复制到部署目录 `.env.server`，版本／端口等从 [server.env.example](../deploy/server.env.example) 复制到 `.env`。服务器复用统一 PostgreSQL 和 Redis，不由应用创建基础设施。`scripts/bootstrap.ps1 -Start` 与根 Compose 仅供本地开发，不再承担生产部署。

```powershell
docker compose --env-file .env -f compose.server.yaml run --rm --no-deps migrate python -m app.config --production
```

此预检只验证配置格式，不代表数据库、文件卷、身份服务可用，也不代表身份服务已经登记正确的资源授权与回调。Compose 的 `config --quiet` 同样不能替代身份校验。

服务器 Compose 固定 `APP_ENV=production`、`DEV_AUTH=false`；预检仍核对最终生效配置，不能用环境文件表面值绕过。先预检，迁移和切流分别显式执行，见[部署规范](DEPLOYMENT.md)。

## OIDC 必需项

官网也使用同域名和现有客户端，精确回调为 `https://comics.nodelane.net/auth/callback/`（含尾斜线）；所有语言共用此回调，登录后返回原语言页面。保留已有插件和私有后台回调，身份端点允许官网 origin。官网使用 public client 的 PKCE 流程，不配置 client secret，运行与会话边界见[官网说明](../backend/website/README.md#内容与规范)。

管理后台入口改为私有 `ADMIN_WEB_PATH`，为空时关闭页面。部署前须在 Logto 新增 `https://<服务域名><ADMIN_WEB_PATH>` 精确回调（含尾斜线）；保留插件及其他客户端回调，不改变现有身份端点、Client ID 或 Audience。新入口不会通过公开身份配置返回。迁移顺序见[后台入口与登录](ADMIN_CONSOLE.md#登录)。

| 配置 | 要求 |
| --- | --- |
| `OIDC_ISSUER` | 令牌的精确 issuer，HTTPS |
| `OIDC_AUDIENCE` | API 资源真实 Identifier，不能使用浏览器应用 ID |
| `OIDC_CLIENT_ID` | 已登记的浏览器 / 扩展应用 ID |
| `OIDC_JWKS_URL` | 身份服务 HTTPS JWKS 地址 |
| `OIDC_AUTHORIZATION_ENDPOINT` / `OIDC_TOKEN_ENDPOINT` | HTTPS 授权码及换令牌端点 |
| `CORS_ORIGINS` | 精确 HTTPS 网页来源，不能含路径、通配符或凭据；只服务扩展时可空 |
| `EXTENSION_IDS` | 逗号分隔的固定 32 字符扩展 ID；不允许扩展来源通配符 |

插件有 `identity` API 时使用 `chrome.identity.getRedirectURL('oidc')`；缺少该 API 的 Firefox Android／Firefox 格式移动包根据固定 Gecko ID 生成相同回调，不使用随机的 `moz-extension://<UUID>` 阅读页。普通网页回调仍为实际 origin 与路径；更换扩展 ID 后同步身份平台和 `EXTENSION_IDS`。

### Firefox 回调与请求来源

Firefox 的 Gecko ID 固定为 `comics@nodelane.net`，OIDC 回调为 `https://b6537bc59408f22ed5813efab806261a7e62bd16.extensions.allizom.org/oidc`，在 Logto 登记此精确 Redirect URI。插件内部的 `moz-extension://<UUID>` 由浏览器配置决定，不能作为所有安装共用的 Allowed CORS origin。

Firefox 的授权码交换与令牌续期使用同一请求方法：临时 DNR 规则仅移除本插件发往精确令牌端点的 POST 请求的 Origin；规则按扩展来源、完整 URL 和请求类型限定，通过 Web Locks 串行更新并在请求结束或失败后删除。已有主机权限、HTTPS、无 Cookie／Referer、禁止重定向、PKCE、回调 state 与 API 身份校验继续生效，无需登记每个 Firefox UUID。网页和 Chrome／Edge 的 Allowed CORS origins 仍按实际来源配置。

## 撤销与并发行为

支持 `identity.launchWebAuthFlow` 的插件保留浏览器原生授权和既有 OIDC 回调；存在窗口 API 时将新开的身份服务弹出窗口调整为 600 × 760，完成后由浏览器关闭。Firefox Android 等缺少 identity 的环境先创建空白标签页、绑定其 tab ID 和监听，再导航到授权站；只读取该标签页主框架的精确回调，保留 PKCE、state、有效期和返回 issuer 校验，拒绝重复或冲突的回调参数。授权、令牌与回调域均须具有已安装的网站访问权限。这个非 blocking 监听不等于原生网络拦截，不能依赖回调域真的返回网页。

标签页授权成功、取消、关闭、导航失败、发起页面卸载或十分钟超时后移除本次监听，仅关闭本次创建的标签页，不按 window ID 关闭浏览器。凭据和 PKCE verifier 留在原扩展上下文，网页内容脚本不参与换码；阅读页不会导航离开。缺少固定扩展 ID 或必要标签页／请求监听 API 时明确拒绝启动。普通网页阅读器仍使用原页面跳转；Orion 的完整授权与令牌请求能力需 iOS 真机单独验收。

官网、插件与网页阅读器使用相同 issuer、public client 和 API resource，通过身份服务的浏览器 SSO 复用已登录身份；各 origin 的本地令牌与会话仍然独立，不通过网页消息、查询参数或插件桥互传。主动登录统一请求 `openid profile offline_access`，默认 `prompt=consent`，不强制重新输入密码，但仍可能显示授权确认。显式本地退出后下一次登录使用 `prompt=login consent`，保留输入其他账户的能力。本地退出不撤销身份服务 SSO，也不退出其他端或其他应用。依据 [Logto 重新认证说明](https://docs.logto.io/end-user-flows/sign-out) 与[刷新令牌配置](https://docs.logto.io/integrate-logto/application-data-structure)。首次授权必须返回有效的 `access_token`、`token_type=Bearer`、`expires_in` 和 `refresh_token`，由产品 API `/v1/me` 验证身份后建立会话。缺少续期权限时明确报错，不建立缺少必要字段的会话。

### 官网持久会话

- 官网使用现有 `oidc-client-ts` 协议层完成 PKCE、回调和刷新校验。授权 state/verifier 与返回路径只存当前标签页的 sessionStorage；通过 API 验证后，令牌存入按 issuer/client 隔离的单条 localStorage 会话记录，不保留第二份持久令牌库。刷新在读取账户或发送请求前按到期时间自动执行，不依赖后台常驻定时器。
- 同 origin 的 Web Locks 串行刷新轮换；独立短写锁按会话 ID 与原令牌记录比较后提交。退出和换号不等待刷新网络请求，迟到的刷新、回调、401 或读取结果不能覆盖新会话。跨标签页通知只在登录身份变化时更新账户与翻译工作台，不因每次令牌轮换重新加载账单。
- 401 最多刷新并重放一次 GET/HEAD；POST/PUT 等写请求不重放。支付流程从读取报价到创建订单绑定同一会话 ID，不能因中途换号把旧操作提交给新账户。翻译读取、下载与长轮询使用同一认证入口，身份变化时停止旧工作台操作；原图、本地分账户历史和服务端任务保留。
- 断网、超时、身份服务 429/5xx 保留会话并共享 30 秒刷新冷却；仍有效令牌可使用，已过期或被 API 拒绝的令牌不会作为回退发出。身份服务明确撤销则只删除对应会话，业务 403 不登出。
- 退出会清除当前浏览器所有官网标签页的持久会话，不清除插件会话或取消订阅。localStorage 令牌仍可被同 origin 的恶意脚本读取，持久化会扩大 XSS 的长期暴露面；继续保持严格脚本 CSP、精确 HTTPS 身份端点、PKCE 和刷新令牌轮换，不引入第三方脚本或放宽脚本策略。此 SPA 方案不具备 HttpOnly 服务端会话的隔离性。
- 持久化和自动刷新不等于无限期登录。实际期限受 Logto 应用刷新令牌 TTL、app grant、撤销和 SSO 会话分别约束；SPA 的刷新令牌轮换不会延长原始 TTL。具体天数必须核对线上应用配置，不能采用客户端常量或把官方默认值当成当前设置。延长期限需另行授权修改身份服务，客户端实现不修改远端 TTL。参见[应用令牌设置](https://docs.logto.io/integrate-logto/application-data-structure)与[SSO 会话设置](https://docs.logto.io/sessions/session-configs)。

### 客户端会话与续期

- `src/auth` 统一管理新会话模型：每次登录独立的会话 ID、服务 origin、用户、访问令牌、到期时间、提前刷新时间和 OIDC 续期凭据。Chrome / Edge 在 `chrome.storage.local` 的 `nc-auth` 中保存一份，限制为 `TRUSTED_CONTEXTS`；Firefox 缺少 `setAccessLevel`，使用扩展 origin 的 `node-comics-auth` IndexedDB，网页内容脚本不能读取该库，`storage.local` 的 `nc-auth` 仅保存会话 ID 和随机变更标记，用于通知其他扩展上下文。网页阅读器在自身 origin 的同名 localStorage 记录保存。凭据不在阅读器与后台间镜像。旧会话读写已删除，没有旧账户或旧数据迁移、双写与兼容回退；更新后需重新登录。
- 活跃阅读器在令牌到期前最多 60 秒自动续期（短令牌取有效期的 10%）；恢复前台和发起带账户认证的请求时同样检查。关闭页面后不依赖常驻定时器，扩展后台下次工作时按需续期。开发测试会话依照后端 `expires_in=43200` 到期，不能自动重新签发开发身份。
- 通过同 origin 的 Web Locks 合并多页面／后台的续期。刷新请求携带原 client ID 与 API resource；先持久保存轮换后的凭据，再发送业务请求。独立写锁允许用户在续期期间退出或切换账户，迟到结果按会话 ID 和已使用令牌核对，不恢复旧账户。
- 产品 API、需认证的原图上传、同源图片下载与状态长轮询统一处理 401：最多续期一次并以原请求体、原幂等键重试一次；仍为 401，或身份服务明确拒绝续期，清除会话和续期凭据，通知所有阅读器及网页翻译上下文停止旧账户请求。页面显示重新登录入口，图内显示登录操作；保留原图、阅读位置和服务端持久任务。
- 断网、15 秒续期超时、身份服务 429 或 5xx 保留会话，并共享 30 秒续期冷却。仍有效的访问令牌可继续使用；已过期的令牌不会发给业务接口，显示可重试的连接错误。业务 403 不登出。结果下载携带同一中心的账户授权，不使用签名 URL；下载失败保留任务成功状态。
- 登录可持续多久由实际访问令牌、Logto 刷新令牌及 grant 生命周期共同决定，不在插件内假定固定天数；续期不能保证无限登录。后台 JWT 签名和到期校验继续生效。

客户端验证命令：

```powershell
cd apps/extension
npm run check
npm test
npm run build
npm run dev -- --port 5187
```

浏览器夹具为 `http://127.0.0.1:5187/tests/auth-lifecycle-fixture.html`，使用模拟身份与 API 检查自动续期、断网、撤销、双标签页退出与阅读位置。真实 OIDC 授权、令牌轮换和后台休眠恢复单独验收。

### 服务端撤销与并发

JWKS 只缓存完整公钥集合，默认最长 300 秒，可用 `OIDC_JWKS_CACHE_SECONDS` 缩短到 1–300 秒。单钥无期限 LRU 缓存已经移除。集合到期必须重新获取；获取失败不再使用过期公钥放行。因缓存存在，服务端撤销的公钥最迟在缓存到期后被拒绝，并非瞬时撤销。JWT 继续校验签名、issuer、audience、到期和非空 subject。

同一个 OIDC issuer / subject 首次并发访问时，唯一约束冲突会回滚并复用已提交的用户，所有请求得到同一身份。没有旧身份结构或旧数据兼容路径。

隔离测试命令：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_identity_config.py tests/test_oidc.py -q
# 专用 PostgreSQL 测试数据库；连接设置参见 test_postgres_concurrency.py 的 pg_scope。
$env:RUN_POSTGRES_CONCURRENCY = '1'
.venv/Scripts/python.exe -m pytest tests/test_oidc_postgres.py -q
```

已验证配置失败关闭、ES384 / 签名 / issuer / audience / subject、真实 PyJWT 集合缓存的撤销及轮换、过期缓存断网拒绝，以及真实 PostgreSQL 8 路同时首次登录只产生一个用户、冲突后事务可继续、后续角色撤销。测试使用临时密钥和数据库，没有访问真实用户或调用图片模型。真实 OIDC 登录与公开部署仍未验证。
