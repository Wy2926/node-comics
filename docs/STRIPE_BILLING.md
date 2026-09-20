# Stripe 支付与会员

2026-09-20：支付统一采用 Stripe。插件和官网直接打开 Stripe 托管 Checkout；取消续费、账单和付款方式由 Stripe Customer Portal 管理。后端使用官方 `stripe-python`，不加载客户端支付 SDK，不收集银行卡，不保留旧支付适配。代码实现与本地模拟验收不代表已启用真实收款。

## 套餐与用户体验

唯一在售套餐 PLUS：US$9.99／月。首次符合资格的账户绑卡试用 7 天，常规翻译不限累计页数，试用含 30 页 AI 重绘；转付费后每个已结清月账期 300 页重绘，剩余不累积。每滚动 60 秒最多新增 100 张翻译图片，跨模式、语言和设备合计。

插件账户页使用简洁会员卡展示价格、权益、试用与自动续费规则。点击“免费试用 7 天”或“通过 Stripe 升级”后直接打开 Stripe 链接，无官网中转结账页。已订阅用户打开 Stripe 管理订阅；返回插件时核对权益，也可手动刷新。未登录、读取失败、支付未配置及链接打开失败均有对应状态。

完成 Checkout 后进入独立 `/payment/success/` 页面，使用该结账意图已冻结返回地址的 origin；取消结账和客户门户仍使用 `STRIPE_RETURN_URL`。成功页无需登录，提示切回插件继续阅读及必要时刷新权益，提供五语切换；不包含支付标识、金额或个人信息，不因为访问页面就发放会员权益。页面禁止缓存及搜索索引，权益仍由验签回调与服务端对账确认。已经创建的 Stripe 会话继续使用其原有成功地址。

当前成功页默认中文、按 URL 切换语言，尚无偏好记忆。浏览器语言、手动偏好与搜索引擎的后续规则见[官网语言设计](WEBSITE_LANGUAGE_DESIGN.md)，该语言方案尚未实施。

采用服务端创建的 Checkout Session URL，而非所有人共用一个可修改用户编号的静态链接。账号来自现有登录身份，客户端不能提交价格、客户 ID、试用资格或订阅所有者。支付会话的 `client_reference_id` 与两处 metadata 绑定随机结账意图；银行卡信息只进入 Stripe。

## 配置

安装 `backend/requirements.txt`。API 与 maintenance 使用同一份配置和新数据库：

| 配置 | 用途 |
| --- | --- |
| `STRIPE_ENABLED` | 默认 false，配置完成后启用 |
| `STRIPE_ENVIRONMENT` | test 或 live；生产服务仅允许 live |
| `STRIPE_SECRET_KEY` | 对应环境的后端 Secret key |
| `STRIPE_WEBHOOK_SECRET` | 对应 Webhook endpoint 的 `whsec_` 签名密钥 |
| `STRIPE_PRODUCT_ID` | PLUS 的 `prod_` 产品 ID |
| `STRIPE_PRICE_ID` | `price_` 月付 USD 999 美分、quantity=1 的 recurring licensed 价格 |
| `STRIPE_RETURN_URL` | 结账完成／返回与客户门户的 HTTPS 返回页，例如官网 `/account/` |

在 Stripe 建立一个 PLUS 产品和上述月付价格。试用由服务端在首次 Checkout 的 `subscription_data.trial_period_days=7` 指定，`payment_method_collection=always`；无需两个价格。Checkout 仅接受银行卡，避免未验证的异步付款方式。当前不开放改价、数量、优惠码、额外商品、升级降级或按比例补差；余额抵扣后已结清的零现金月账单仍按正常账期履约。

在 Stripe 配置 Customer Portal：允许更新付款方式和查看账单，允许在当前周期结束时取消，关闭套餐切换、数量调整和即时取消。退款申请保持人工处理，系统不自动发起退款；退款／争议后的权益撤销政策尚未自动化，不能把取消续费当成退款。

Webhook 地址：`https://<API 域名>/webhooks/stripe`。API 版本固定为 SDK 15.6.1 对应的 **2026-08-26.dahlia**，Webhook 建议使用同版。订阅以下事件：

- `checkout.session.completed`、`checkout.session.expired`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`
- `customer.subscription.created`、`customer.subscription.updated`、`customer.subscription.deleted`、`customer.subscription.paused`、`customer.subscription.resumed`
- `invoice.paid`、`invoice.payment_failed`、`invoice.payment_action_required`、`invoice.voided`、`invoice.marked_uncollectible`

测试配置使用独立 test/development 服务与数据库；本地转发可使用官方 Stripe CLI：`stripe listen --forward-to localhost:18088/webhooks/stripe`，签名密钥取该监听实例。真实开通验收需要在上述环境中配置实际测试产品、密钥、回调和 Portal，再完成测试卡付款、试用转正式、续费失败、取消以及回到插件刷新。当前沙盒已配置产品、回调和 Portal，验证范围见下方接入记录；未执行测试卡或生产付款，未部署生产环境。

## 持久化与幂等

新库基线为 `stripe_0001`，不提供旧库升级、字段回填、双写或兼容路由。已有旧版本号的库启动失败，必须创建新数据库／schema；不会自动删除运行库、漫画和 R2 对象。

- `billing_accounts`：账户与 Stripe Customer 绑定、环境及首次试用使用记录。
- `billing_checkouts`：唯一在途意图、固定请求参数、Stripe Session ID、到期与核实状态；不保存可直接使用的 Checkout URL。
- `billing_subscriptions`：可信会话建立的订阅关系、生命周期及已授权试用／付费期限。
- `billing_invoices`：每份已处理账单一条回执，和额度发放在同一事务提交。
- `billing_events`：官方 SDK 对原始请求体验签后持久化，仅保存事件 ID、资源 ID、类型、重试状态；不保存完整报文或客户资料。

每次创建 Stripe 会话使用持久化的 `checkout:<意图ID>` 幂等键。网络中断后保留原意图，使用完全相同的参数恢复；接近过期或超过幂等保留时限时只分页查询原会话，不重新 POST。找不到确切结果时继续保留待核实状态，不自动生成第二笔购买。

收到通知后重新获取 Stripe 当前会话、订阅及账单，校验环境、账号、客户、产品、价格、数量和账期，不依赖 Webhook 到达顺序。账户锁串行化授予；发放键包含订阅与账期，重复通知、并发对账及多页重放不重发额度。未付款、按比例调整、非套餐账单不新增权益；试用转正式时关闭试用额度有效期。取消续费保留已发当期权益，逾期未付款不凭 `active` 状态预发下一期。

maintenance 重试持久事件，并核查在途结账与有效订阅。已完成但尚未绑定订阅的会话也继续核查。账单补查遍历已付款记录，不以账单创建时间作为游标，避免漏掉早先创建、后来付款的账单；每次全量扫描按账单回执跳过已处理项，分页中断回滚本次事务。

运营赠送仍独立于 Stripe 账期，沿用[会员与额度](MEMBERSHIP_AND_QUOTAS.md)，不改变 Stripe 扣款日期。

## 接口与验证

| 接口 | 行为 |
| --- | --- |
| `GET /v1/billing/status` | 当前账户试用资格、结账与订阅状态 |
| `POST /v1/billing/checkouts` | 创建或恢复账户的 Stripe Checkout URL |
| `POST /v1/billing/portal` | 当前账户的 Stripe Customer Portal URL |
| `POST /v1/billing/sync` | 核对 Stripe 并返回最新订阅与权益 |
| `POST /webhooks/stripe` | 原始体验签、持久事件、后台处理 |

旧支付客户端、SDK 交接页面、公开配置／令牌交接接口、自建取消接口、专用沙盒脚本、旧测试夹具和价格示例全部删除。

可复现验证命令（仓库根目录，Python 已安装后端依赖）：

```powershell
python -m pytest backend/tests/test_stripe_billing.py backend/tests/test_request_limits_migration.py backend/tests/test_membership.py backend/tests/test_membership_days.py -q
npm --prefix apps/extension run check
npm --prefix apps/extension test
npm --prefix apps/extension run build
npm --prefix backend/website test
npm --prefix backend/website run build
```

支付测试通过官方 SDK 的 HTTP transport 模拟 Stripe，覆盖响应丢失、重复请求、试用转付费、取消／欠费、跨账户门户、签名、重放、分页失败恢复及并发发放。PostgreSQL 用例位于 `test_billing_postgres.py`，按[后端并发验证说明](../backend/README.md)显式启用；未运行的 PostgreSQL 场景不算通过。

## 本地验收记录

2026-09-20 插件焦点刷新修复：背景状态读取与打开 Stripe 使用独立状态，普通 focus/visibilitychange 在 30 秒内合并，只读持久状态；手动刷新或实际打开 Stripe 后返回才对账。沙盒插件通过类型、模块检查与构建。`tests/billing-focus-fixture.html` 在 5192 端口使用模拟 API 和模拟窗口交接，Chrome 验证重复焦点、慢刷新期间打开、双击合并、返回对账、失败重试八个断言；不访问真实账户或 Stripe。原本模拟套件没有覆盖的 UI 状态竞争由此补齐。

2026-09-20 真实沙盒接入：使用独立 PostgreSQL 空库、R2 前缀、现有 OIDC 和临时 Cloudflare Tunnel，已创建测试产品、USD 999 美分月付价格、Customer Portal 和同版 Webhook。通过真实后端创建绑卡 7 天试用 Checkout，再主动使该验收会话过期；Stripe 的 `checkout.session.expired` 已经隧道验签入库并处理。未提交测试卡付款；订阅开通、试用转正式和取消续费留给手动验收。未发布生产服务。

真实接入发现 `UrllibClient(timeout=20)` 不受当前 SDK 支持，改为 `RequestsClient(timeout=20)`；新增使用实际 SDK 初始化与同步请求的离线回归，支付套件共 29 项通过。插件支持构建时 `VITE_API_BASE`，沙盒构建通过类型、模块检查和 Chrome MV3 打包。浏览器自动化策略禁止访问扩展页面，本轮插件交互由用户手动检查。

同环境的 RTX 4060 Vulkan 节点已完成原创日文样张到简体中文的真实 OCR、文本供应商调用、抹字、嵌字与 R2 存取；最终 PNG 为 900×1200，摘要、解码与固定扩展 origin 的 CORS 响应已核对。这是单张链路验收，不代表自然漫画总体质量；未配置图片重绘供应商密钥。

- 相关后端回归 60 项通过，2 项 PostgreSQL 并发用例因未启用专用数据库跳过。完整后端首次运行 525 项通过、108 项按环境条件跳过，发现的 2 个旧路由 405 问题已修复，并在上述相关回归中通过；没有把首次完整运行记为全绿。
- 插件 317 项单元测试、类型／模块检查及 Chrome MV3 构建通过；官网 5 项测试、类型检查及 105 页静态构建通过。
- Chrome 运行实际插件 React 页面和隔离 API 夹具，检查中文会员卡、亮／暗主题、未登录、普通／PLUS、支付失败、禁用支付与手动刷新。点击分别到达 `checkout.stripe.com` 和 `billing.stripe.com`；夹具链接为无效模拟会话，仅验证跳转，不证明真实支付成功。返回时监听焦点与页面可见性变化刷新权益。
- 浏览器复现：在 `apps/extension` 运行 `npm run dev -- --port 5179`，打开 `/tests/reader-fixture.html?billing=enabled#account`；将 `billing` 改为 `paid`、`checkout-error`、`error` 或 `disabled` 检查对应状态，附加 `theme=dark` 检查暗色主题。另一个已有入口 `/tests/account-fixture.html` 继续仅使用 5186 端口。

## 依赖与参考

官方 `stripe-python==15.6.1`，MIT；不含模型权重和字体。PyPI wheel SHA-256：`b33e1ea76462d7289e5fe755a1132b82099151bfb31e961021655471e6d216bf`；源码包 SHA-256：`9f3986aa960419041aba9c76191746bdf2c342c95892acfbf6edb500ab006d31`。默认不启用 Stripe debug 日志或保存原始支付报文。

来源：[官方 SDK 与许可证](https://github.com/stripe/stripe-python/tree/v15.6.1)、[PyPI 版本](https://pypi.org/project/stripe/15.6.1/)、[Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)、[订阅通知](https://docs.stripe.com/billing/subscriptions/webhooks)、[Webhook 签名](https://docs.stripe.com/webhooks)、[Customer Portal](https://docs.stripe.com/customer-management)。
