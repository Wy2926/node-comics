# NodeLane 官网

官网位于 `backend/website`，使用 **Astro + React + TypeScript**。公开内容构建为完整 HTML，账户和图片对照使用 React 岛；没有原生 JavaScript 页面或单页应用的空壳首页。API 与官网共用 `https://comics.nodelane.net`，不需要第二个域名或独立 Node 线上进程。

## 页面与内容

首页、功能、US$9.99/月定价、Chrome / Edge / Firefox 下载、帮助反馈、FAQ、关于、更新日志、隐私政策、条款、订阅与退款说明，以及六篇实用指南：漫画翻译入门、两种翻译方式、本地文件阅读、日漫阅读、翻译问题排查、漫画隐私。联系方式统一为 `comics@nodelane.net`。

权益依据 [会员与额度设计](../../docs/MEMBERSHIP_AND_QUOTAS.md)，使用服务端实际账户与订阅接口。结账跳转所选 Stripe 或 Creem 官方托管页面，订阅管理使用原渠道的 Customer Portal；页面本身不收集银行卡。支付渠道均未开启时，账户显示订阅服务不可用；不会伪造已开通订阅。

五种语言独立维护，不在浏览器中机器转换或下载所有字典：

| 语言 | 独立字典 | 路径 |
| --- | --- | --- |
| 简体中文 | [zh-CN.ts](src/i18n/zh-CN.ts) | `/` |
| 繁体中文 | [zh-TW.ts](src/i18n/zh-TW.ts) | `/zh-tw/` |
| English | [en.ts](src/i18n/en.ts) | `/en/` |
| 日本語 | [ja.ts](src/i18n/ja.ts) | `/ja/` |
| 한국어 | [ko.ts](src/i18n/ko.ts) | `/ko/` |

每份字典包含导航、页面、文章、政策、FAQ、更新日志和账户交互文案；类型约束及测试检查完整性。语言切换保留当前页面，登录后返回原语言账户页。添加内容须同步五份字典。中文名为 NodeLane 漫译／NodeLane 漫譯，其他语言为 NodeLane Comics；沿用插件已确认的 Logo。

## 配置与运行

在 [src/data/site.ts](src/data/site.ts) 维护公开域名、邮件和三个商店 URL。下载页优先提供 Chrome / Edge 通用 ZIP 与手动安装、更新说明；三张商店卡片使用本地官方浏览器 Logo，空地址按钮不可点击。Firefox 不提供未签名 ZIP 安装入口。

安装包版本目录由 [extension-release.json](../extension-release.json) 维护，`current` 选择官网展示版本，`releases` 保留历史版本。每个版本拥有独立、长期有效的 `/downloads/node-comics-<version>-chromium.zip` 地址；后台仅为目录中精确匹配的安装包生成 600 秒 R2 GET 签名并返回不缓存的 302，前端不保存签名 URL。R2 保持私有，安装包位于既有业务前缀下的 `releases/extensions/<version>/<sha256>/<filename>`，与漫画对象目录分离。未知包返回 404，存储配置不可用时返回可重试的 503。

发布新版时先在 `apps/extension` 用正式 `VITE_API_BASE=https://comics.nodelane.net` 执行 `npm run check` 与 `npm run zip`，递增插件版本；计算 ZIP 字节数和 SHA-256，向版本目录追加条目，保留旧条目，再更新 `current`。使用后端依赖与生产 R2 环境运行 `python scripts/upload_extension_release.py --zip <zip> --manifest backend/extension-release.json`：校验包和正式 API 地址，按不可覆盖方式上传并重新读取核对哈希。验证成功后构建并部署官网及后端；仅发布静态页面不能启用下载端点。

`node scripts/verify_website_download.mjs` 从仓库根目录检查五语下载页、安装步骤和浏览器 Logo；设置 `WEBSITE_PREVIEW_URL=https://comics.nodelane.net` 后会真实点击下载，并核对文件名、大小、SHA-256。Playwright 模块可通过 `PLAYWRIGHT_MODULE` 指定。

Node.js 22.12+（建议使用 Docker 中的 Node 22），本机开发命令：

```powershell
cd backend/website
npm ci
npm run dev
npm test
npm run build
npm run preview
```

`dev` / `preview` 为 4321 端口的纯前端入口，只适合检查公开页面。完整登录需要同源 API，不能在纯静态预览里使用开发身份替代正式 OIDC。

从仓库根目录运行完整的本地隔离验收夹具（不读生产环境文件，不访问 DB / R2 / 图片供应商，不收款）：

```powershell
uv run --with-requirements backend/requirements.txt python backend/tests/manual_website_server.py
# 打开 http://127.0.0.1:4322/；先完成上面的 npm run build。
```

夹具只监听 127.0.0.1，合成身份只被该进程认可；不要公开部署。它检查 PKCE 并支持模拟 API 故障、刷新令牌失效、订阅与取消。`POST /test/reset` 可设置 `me_failure`、`refresh_failure`、`subscribed`，`GET /test/state` 查看隔离计数。

正式 Docker 构建自动完成官网、管理后台构建并复制到 Python 镜像：

```powershell
docker build -f backend/Dockerfile -t node-comics-website-check:local backend
```

`app.website.WebsiteFiles` 最后挂载，已有 `/v1/`、`/billing/`、内部 API 和私有管理后台优先。构建缺失时官网返回 404，API 仍可运行。本机直接启动真实后端前，可把 `backend/website/dist` 内容复制到被忽略的 `backend/app/website_dist`；重建时完整替换该产物目录，避免旧页面残留。无需修改数据库。

OpenResty 的根路径已改为沿用同一 upstream；不配置 SPA 回退。已有部署需重新构建并更新代理配置，本次代码验证不代表已部署线上。

## OIDC 与账户

复用 `/v1/auth/config` 的 issuer、client ID、audience、端点和 scope，授权码 + PKCE S256，拒绝开发登录配置。身份平台中为**同一个客户端**补充精确回调 `https://comics.nodelane.net/auth/callback/`（含结尾斜线）并允许官网 origin；保留插件和管理后台回调。所有语言共用这一个回调。

只使用 public client，不需要也不允许把 client secret 或图片 API 密钥放入前端。账户会话存在当前标签页的 sessionStorage；授权返回先清除 URL 中的 code，再用 `/v1/me` 校验真实 API 身份。访问令牌按需续期，GET 遇到 401 最多续期重放一次；结账和取消等 POST 不自动重放。明确撤销的续期凭据会清除，临时网络错误保留以供重试，退出期间迟到的续期结果不能恢复会话。退出只清除官网标签页会话，不退出插件或身份平台中的其他应用。

账户页仅展示身份、会员状态与有效期、订阅状态及管理入口；阅读、翻译和详细用量在插件内查看。未订阅时默认收起套餐选择，从定价页带入报价或存在未完成结账时自动展开。支持选择月付／年付并自动使用全站默认渠道、继续原渠道结账、通过原渠道 Customer Portal 管理订阅与取消续费。初始 PLUS 产品价格为 US$9.99/月及 US$99.99/年，年付每月发放 300 页，实际税费及金额以结账页为准。真实身份平台的回调登记与真实支付未在隔离夹具中验证。

`/payment/success/` 是完成 Checkout 后的独立展示页，含五语版本，无登录要求、不发放权益、不请求支付详情；引导用户切回插件，必要时刷新账户。该页不进入 sitemap，返回 `private, no-store` 和 `noindex, nofollow`，不会把取消结账或客户门户返回显示为成功。

当前语言由 URL 决定，未存储用户语言偏好。首次匹配浏览器、手动选择记忆、中立入口与固定语言 URL 的方案见[官网语言设计](../../docs/WEBSITE_LANGUAGE_DESIGN.md)；设计已完成，路由和偏好机制尚未实施。

## SEO、缓存和视觉

- 90 个可索引地址（18 页 × 5 语言），每页完整正文、唯一标题、描述、canonical、互相对应的 hreflang、x-default、Open Graph / Twitter。账户、回调和错误页 noindex，不进入 sitemap。
- `/sitemap.xml`、`/robots.txt` 和五语更新日志 RSS。文章互链、面包屑、图片替代文本和固定尺寸；不按浏览器语言强制跳转，保留稳定可抓取 URL。
- JSON-LD 包含 Organization、WebSite、WebPage、BreadcrumbList、SoftwareApplication、定价 Service/Offer、Article 和可见 FAQ 对应的 FAQPage。不伪造评分、评论、下载数量或商店地址。结构化数据不保证排名或搜索引擎展示富结果。
- HTML 允许缓存但每次重新校验；带 hash 的静态资源缓存一年。账户和回调 `private, no-store`。真实 API 继续 `private, no-store`，不会因挂载官网而变成公开缓存。不存在的页面返回真实 404，尾斜线与 index.html 统一到规范 URL。
- CSP 使用构建脚本的 SHA-256 授权 Astro 岛初始化，不放开任意内联脚本；脚本、字体、图片均本地提供，连接只允许同源和配置的身份令牌端点。默认无统计脚本、广告 Cookie 或第三方字体。
- 视觉颜色、描边、折角圆角、硬阴影和网点来自插件登录窗口的 [tokens.css](../../apps/extension/src/ui/theme/tokens.css)。响应式布局支持移动端，支持键盘焦点与减少动态效果偏好。Logo 来源于插件，介绍插画通过指定图片接口生成，提示词与来源见 [ASSETS.md](ASSETS.md)。

构建检查会验证 HTML 标题、单一 H1、语言、canonical/hreflang、JSON-LD、图片属性、站内链接、sitemap 与私有索引边界。技术参考：[Astro 静态输出](https://docs.astro.build/en/guides/on-demand-rendering/)、[Google 多语言页面](https://developers.google.com/search/docs/specialty/international/localized-versions)、[Google 结构化数据](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data)。

## 验收与公开上线边界

2026-09-20：类型检查和 105 页静态构建通过，五语字典／路由与 OIDC 配置单元测试 5 项通过，网站、私有后台和身份配置相关后端测试 51 项通过。Linux Docker 全镜像构建通过。浏览器检查包括桌面／390px 移动布局、日文语言切换保留路径、繁中指南、韩文首页、图片对照、PKCE 登录及英文账户回跳、授权失效后的重新登录、503 保留会话及重试恢复、模拟结账跳转和取消续费确认。截图位于仓库忽略的 `artifacts/website-validation/`。这是模拟身份与支付验证，不替代真实 Logto 和 Stripe 验收。

依赖升级后执行 `npm run notices` 更新 [依赖许可](DEPENDENCIES.md)、公开许可证和图片校验和。后端相关回归命令（仓库根目录）：

```powershell
uv run --with-requirements backend/requirements.txt python -m pytest backend/tests/test_website.py backend/tests/test_admin_web.py backend/tests/test_identity_config.py -q -p no:cacheprovider
```

本次完成代码、原创插画和本地验证，未提交、推送或公开部署。商店上架后填写对应地址；正式登录需登记 OIDC 回调，并由运营方核对实际主体名称、付款商品和政策联系方式；当前政策署名为产品团队，未编造公司登记信息。Search Console / Bing 站长平台验证及 sitemap 提交需要对应账户，未代为提交。

2026-09-20 多渠道支付更新：官网支持后台指定的唯一 Stripe／Creem 默认渠道、月付／年付、在途订单固定原报价及渠道、按订阅所属渠道进入客户门户。11 项测试、类型检查与 110 页构建通过；隔离浏览器验证月／年切换、Creem 参数、在途恢复、到期及退款撤权后重新订阅和 390px 布局。真实支付由[订阅验收](../../docs/SUBSCRIPTION_ACCEPTANCE.md)单独记录，配置见[多渠道支付](../../docs/STRIPE_BILLING.md)。

定价页的年付优惠仅比较公开目录中同产品、同权益版本、同币种的月付与年付报价：以月付金额 × 12 为基准，展示年付总额、折合月价和节省金额；节省比例四舍五入保留一位小数并标注约数。缺少可比月价或年付没有优惠时不显示折扣。当前默认报价年付省 US$19.89（16.6%），折合 US$8.33/月，实际按 US$99.99/年扣款。定价页不创建优惠券或修改结账金额。

定价页浏览器验收（使用本机已安装的 Chrome 和 Playwright，报价完全模拟，不调用支付）：先启动上面的开发／预览服务，再从仓库根目录运行 `node scripts/verify_website_pricing.mjs`。可用 `WEBSITE_PREVIEW_URL` 指定预览地址、`PLAYWRIGHT_MODULE` 指定 Playwright 模块绝对路径。覆盖五种语言、320–1440px 布局、语言与月年付切换、加载／失败／空目录／仅年付状态；截图保存到 `artifacts/website-pricing/`。若开发环境提示 `_jsxDEV is not a function`，停止开发服务并以 `NODE_ENV=development` 重启；生产验收使用 `npm run build` 的静态产物。

账户详情浏览器验收：在 `backend/website` 运行 `npx vite --config tests/account-fixture.config.ts`（开发模式、固定端口 5193），再从仓库根目录运行 `node scripts/verify_website_account.mjs`。需要本机 Chrome 和 Playwright，可使用 `PLAYWRIGHT_MODULE` 指定模块路径。夹具使用模拟账户，不访问真实身份、数据库或支付服务；覆盖普通／PLUS、取消／过期、错误、退出、多语言窄屏，以及报价选择和继续结账，截图位于 `artifacts/website-account/`。

2026-09-21 示意图更新：日文原图保留，中文替换为用户提供版本，并新增英文、韩文效果图；四种语言可切换，英文／韩文首页默认展示对应示意图。完整显示漫画，加载及解码期间显示动画，失败可重试，快速切换忽略过期加载结果；窄屏按钮分两列。浏览器验收命令为 `node scripts/verify_website_compare.mjs`（仓库根目录、先启动官网预览，使用本机 Chrome；可通过 PLAYWRIGHT_MODULE、WEBSITE_PREVIEW_URL 指定模块及地址），覆盖五语、四图、320／390／1440px、加载、失败重试、快速切换和位置保持，截图保存于 artifacts/website-compare/。
