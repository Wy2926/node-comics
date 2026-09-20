# PLUS 套餐、绑卡试用与 Paddle 接入设计

2026-09-16。**后端结账、业务 Webhook、自动权益发放与客户端订阅管理已实现，默认关闭；已启动隔离沙盒服务。** 本地支付契约测试 16 项通过，真实 API 创建结账目前返回 `transaction_default_checkout_url_not_set`，需先在沙盒后台保存默认付款链接。实际绑卡、试用转付费和取消尚未完成端到端验收，未启用生产收款。当前接入与复现见第 11 节。

## 1. 唯一套餐

| 项目 | 规则 |
| --- | --- |
| 套餐 | PLUS，US$9.99，每月自动续费，可取消 |
| 试用 | 首次绑定信用卡，免费试用 7 天；每个账户仅一次 |
| 试用权益 | 常规翻译不限量、30 页 AI 重绘；试用结束时剩余试用页数失效 |
| 正式权益 | 常规翻译不限量，每个成功付费的月账期提供 300 页 AI 重绘；不累积 |
| 翻译准入 | PLUS 跨模式、语言和设备每滚动 60 秒最多新增 100 张，无账户在途数量上限，沿用集群公平调度 |
| 首次扣款 | 试用结束时自动扣款；在此前取消避免首次扣款 |
| 续费 | 每月扣款；取消续费后保留当前已获权益至其有效期结束 |
| 税费 | 展示基础价格，结账页确认适用税费及最终金额；税费模式上线前配置并验收 |

用户最终于 2026-09-16 将原定的每 30 天续费改为月付订阅：`interval=month`、`frequency=1`，按订阅月度账期续费，不按固定 30 天或每个自然月 1 日发放。没有年付、永久会员或额外购买页数包。

正式订阅的重绘周期绑定 Paddle 已付款的账期，与管理员按开通日期计算的“会员月”分开。订阅、原交易与事件记录持久化到独立支付表，额度桶按订阅与账期唯一识别；不调用 `membership(months=1)` 模拟付款，试用转正式时关闭 30 页试用桶并创建 300 页付费桶。

## 2. Paddle 配置与信任边界

创建一个 PLUS 产品；首次试用价格的基础金额为 USD `999`，`billing_cycle={interval:"month",frequency:1}`，`trial_period={interval:"day",frequency:7,requires_payment_method:true}`，不设置试用收费金额。数量限定为 1。已试用用户使用同一套餐的无试用价格，避免再次生成 trialing 订阅；这属于同一套餐的结账配置，不是第二个套餐。配置上线前使用 Paddle Sandbox 校验实际返回的价格、周期、绑卡要求及税费。

Paddle 的绑卡免费试用依附于周期价格，试用结束后自动扣款。依据：[创建试用订阅](https://developer.paddle.com/build/trials/create-trial/)、[价格 API](https://developer.paddle.com/api-reference/prices/create-price/)。

信用卡信息由 Paddle 托管结账收集，插件与业务后端不保存卡号或安全码。扩展应打开平台 HTTPS 结账页，后端绑定当前登录账户和唯一结账意图；前端不能指定用户 ID、价格、会员期限或发放数量。API 密钥、Webhook 密钥仅在后端，Paddle.js 使用对应环境的公开 client token。

结账 UI 的成功回调仅用于显示“正在确认”，不能发放权益。接收原始 Webhook 请求体、验证签名及时间容差后，以事件 ID 去重并持久化，再核对订阅、交易、价格、币种、金额及平台账户绑定。乱序事件按发生时间与 Paddle 当前状态核实，不回退已确认的账期；通知重试、补拉及并发处理不能重复延长会员或发页数。依据：[权益同步](https://developer.paddle.com/build/subscriptions/provision-access-webhooks/)、[签名验证](https://developer.paddle.com/webhooks/about/signature-verification/)。

## 3. 生命周期与交互

1. 普通用户在账户页查看“PLUS · US$9.99 / 月”和“绑卡免费试用 7 天”，同时展示试用 30 页重绘及自动扣款说明。接入未就绪时只显示说明，不提供虚假的试用领取按钮。
2. 服务端检查是否已试用、是否已有活动订阅、是否有未完成结账。同一意图重复点击恢复原结账。运营赠送 PLUS 与订阅按各自期限并行生效，额度独立，优先消耗最早到期的额度；赠送不会覆盖订阅，也不会顺延 Paddle 扣款日期。
3. 经验证的 `trialing` 开启精确 7 天试用，30 页重绘绑定该试用，不因重新登录、取消再订阅、回调重放或删除本地数据重复领取。绑卡本身不证明唯一自然人，账户防重复之外的滥用控制需另行评估，不能宣称“一卡一次”已实现。
4. 首笔付款核实成功后关闭试用桶，创建该付费周期的 300 页额度。试用任务仍按原试用桶结算；失败归还原桶，到期后不复活。未来续费仅在对应账期付款成功后发放，失败或待付款不先发下一期。
5. 账户显示状态（确认中／试用中／已订阅／已取消续费／付款失败）、具体试用或当前账期到期时间、下次扣款日期、价格及进入 Paddle 管理订阅的入口。取消成功后显示权益截止时间；平台不能只隐藏按钮而未真正取消 Paddle 续费。
6. 权益到期后暂停本地未受理的新增；已受理任务继续，历史译图按原授权保留。运营赠送额度按自己的有效期继续生效，订阅到期不撤销独立赠送。

## 4. 收费前仍需完成

- 商户审核、产品与两个价格配置、Sandbox／生产环境隔离、公开 HTTPS 结账页、Webhook 地址和签名密钥，以及付款、试用转正式、取消和退款的沙箱端到端验收。
- 退款规则尚待业务确认：全额退款是否立即结束剩余付费权益；部分退款如何处理；争议、拒付及宽限期如何处理。任何方案都需绑定原交易和来源，不撤销无关赠送，不静默重扣既有任务。批准退款不等于产品授权已经正确同步。
- 验证无限常规翻译的实际交付成本、活跃用户分布、连续使用及空闲借用吞吐、Paddle 费用与税费后的收入、试用转化和退款比例。US$9.99 是已确认价格，尚无成本可持续性结论；不以隐藏累计额度限制代替成本验证。
- 试用提醒、续费提醒与取消入口的实际送达和可用性；税费及退款页面文案一致性。

## 5. 运营赠送（当前已实现）

独立后台“用户管理 → 用户权益”可赠送 PLUS 1–3660 天，开通时明确每会员月重绘额度（可为 0）；续期保留原会员段规则，从当前到期时间延长。天数按 24 小时计算。该功能不是 Paddle 绑卡试用，管理员赠送不扣用户信用卡，也不创建自动续费。

同一界面可赠送常规／重绘 1–1,000,000 页，指定立即或预约生效、到期时间与备注。提交中禁用重复操作；未知结果保留原请求与幂等键，关闭详情或刷新后可恢复核实。查看最近生效的 50 笔额度，包含预约、耗尽与过期记录。成功后显式创建另一笔操作，避免重复点击再次赠送。

## 6. 自定义数据：用于关联账户，不决定权益

Paddle 的自定义数据是可选项。创建产品／价格时可以留空；不要把某个用户的 ID 写在所有人共用的产品／价格上。平台后端创建每笔结账交易时，建议提供以下 `custom_data`：

```json
{
  "app": "node_comics",
  "checkout_intent_id": "REPLACE_WITH_BACKEND_GENERATED_OPAQUE_ID"
}
```

平台数据库保存结账意图与登录用户、试用资格、允许使用的价格、Paddle 交易及订阅的映射。无需在自定义数据里放邮箱、登录令牌、卡信息或可由客户端改写的会员天数／额度。上述字段已由后端创建交易时写入。

API 字段名是 `custom_data`；Paddle.js 的对应参数是 `customData`。交易上的自定义数据会复制到新订阅，订阅的数据又会带入后续续费交易；相关 Webhook 的实体数据中包含 `data.custom_data`，不需要另给 Webhook 配置一份同名数据。续费仍必须按新的交易 ID 和账期处理，不能把沿用的结账意图当成续费幂等键。依据：[自定义数据与传递规则](https://developer.paddle.com/build/transactions/custom-data/)。

本项目采用后端创建交易、前端按 `transactionId` 打开结账的方式。处理 Webhook 时，除验签外还必须匹配后端已保存的交易／订阅归属、批准的价格与账期；自定义数据只能辅助关联。客户端可填写的数据或结账成功回调都不能直接触发 PLUS 发放。

## 7. 创建试用价格的操作步骤

先在 Paddle Sandbox 中操作，再为生产环境分别创建配置；两个环境的产品、价格、token 和密钥不能混用。

1. 进入 **Catalog → Products → New product**，创建一个 `Node Comics PLUS` 产品，填写实际产品说明及适用税务类别。
2. 打开产品，进入 **Prices → New price**，创建周期价格，按下表配置。免费试用是周期价格的属性，无需另外创建“免费产品”。
3. 在同一个产品下再建一个金额和周期相同、没有试用的价格，供已经领取过试用的账户使用；用户仍只看到一个 PLUS 套餐。试用资格由平台后端校验。

| 配置项 | 首次试用价格 | 已试用账户价格 |
| --- | --- | --- |
| 币种／基础金额 | USD 9.99，API 金额为字符串 `"999"` | 相同 |
| 周期 | 每月，`billing_cycle.interval=month`、`frequency=1` | 相同 |
| 免费试用 | 7 天，`trial_period.interval=day`、`frequency=7` | 无，`trial_period=null` |
| 试用付款方式 | `requires_payment_method=true` | 不适用 |
| 试用收费 | 无，`trial_period.unit_price=null` | 不适用 |
| 购买数量 | 最少 1、最多 1 | 相同 |
| 税费 | 沿用已配置的账户税费模式，结账时显示最终金额 | 相同 |

如果控制台没有所需的精确间隔选项，用后端 API `POST /prices` 创建。请求体已准备好：[7 天试用价格](examples/paddle/plus-trial-price.json)、[无试用价格](examples/paddle/plus-standard-price.json)。先将 `product_id` 占位符替换为上述产品的 `pro_...` ID；这些模板尚未向 Paddle 提交。Sandbox API 基址为 `https://sandbox-api.paddle.com`，生产为 `https://api.paddle.com`，使用后端 API key。

`requires_payment_method=true` 要求提供付款方式，并不单独限制为信用卡。若结账仅展示银行卡，Paddle.js 配置 `allowedPaymentMethods: ['card']`；Paddle 的 `card` 同时包含信用卡和借记卡，不能宣称只接受信用卡。常规不限量、试用 30 页和正式 300 页由平台后端发放，Paddle 价格配置不管理翻译页数。

依据：[控制台创建产品与价格](https://developer.paddle.com/build/products/create-products-prices/)、[创建试用](https://developer.paddle.com/build/trials/create-trial/)、[价格 API](https://developer.paddle.com/api-reference/prices/create-price/)、[结账参数](https://developer.paddle.com/paddle-js/methods/paddle-checkout-open/)。

## 8. Paddle.js 放在平台 HTTPS 结账页

建议流程为：插件“升级 PLUS” → 平台 HTTPS 结账页 → Paddle.js 打开后端创建的交易 → 后端核实 Webhook 并更新权益 → 插件刷新账户状态。

当前扩展是 Manifest V3，扩展页面 CSP 只允许本地脚本。官方 `@paddle/paddle-js` 是带 TypeScript 类型的加载器，安装 npm 包后仍会加载 `https://cdn.paddle.com/paddle/v2/paddle.js`；官方要求运行时从 CDN 加载。因此把 npm 包打进扩展也不能解决远程脚本限制。将它安装在独立网页项目中，无需修改扩展 CSP 或把 Paddle 运行时复制到扩展。依据：[Paddle.js 加载方式](https://developer.paddle.com/paddle-js/about/include-paddlejs/)、[Chrome MV3 远程代码限制](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)。

以下为 npm 加载器的等价调用示例。当前结账页已由后端 `/billing/checkout` 提供，直接加载官方 Paddle.js CDN，并从后端读取交易 ID 和公开 client token：

```ts
import { initializePaddle } from '@paddle/paddle-js';

// clientToken 是公开客户端 token；transactionId 来自已认证的后端结账接口。
const paddle = await initializePaddle({
  environment: 'sandbox',
  token: clientToken,
});
if (!paddle) throw new Error('支付组件加载失败，请重试');
paddle.Checkout.open({
  transactionId,
  settings: {
    displayMode: 'overlay',
    allowedPaymentMethods: ['card'],
  },
});
```

在 **Developer tools → Authentication** 创建对应环境的 client-side token；API key 只放后端。配置 **Checkout → Checkout settings → Default payment link**，指向实际加载 Paddle.js 的结账页；生产结账域名需完成 Paddle 审核。依据：[传入后端交易](https://developer.paddle.com/build/transactions/pass-transaction-checkout/)、[默认付款链接](https://developer.paddle.com/build/transactions/default-payment-link/)。

2026-09-16 已下载并校验官方 npm 包，未安装到扩展依赖；结账网页直接加载官方 CDN：

- 包：`@paddle/paddle-js@1.6.5`，许可 `Apache-2.0`。
- 来源：`https://registry.npmjs.org/@paddle/paddle-js/-/paddle-js-1.6.5.tgz`。
- 本地归档：`artifacts/paddle/paddle-paddle-js-1.6.5.tgz`；解压文件：`artifacts/paddle/paddle-js-1.6.5/package/`，包含 `README.md`、`LICENSE`、加载器及类型。
- SHA-256：`37ae8bb989e780964038d9d698c428e62fd7b65ab3dd278e967d863c2df13f69`；已校验 SHA-512 与 npm registry 的 integrity 一致，记录于 `artifacts/paddle/download.json`。
- `artifacts/` 是忽略的本地产物；将来网页项目可用 `npm install --save-exact @paddle/paddle-js@1.6.5` 重现该依赖。固定的是 npm 加载器版本，Paddle 托管运行时仍由官方 CDN 提供。

## 9. 本次沙盒联调准备

用户于 2026-09-16 提供 Sandbox 产品；以下配置已通过沙盒 API 修改并读回验证：

| 项目 | 用户提供的值 |
| --- | --- |
| 产品 | NodeLane Comics，SaaS，Active |
| 产品 ID | `pro_01m2n5bq6d8g24zyk3598m1hyv` |
| 首次试用价格 ID | `pri_01m2n5drvpjqxqgpbhke2dxz1x` |
| 无试用价格 ID | `pri_01m2n613qg3c08rmshmkxrdw32` |
| 两个价格 | USD 9.99／月，`month × 1`，购买数量固定为 1 |
| 首次试用 | 免费 7 天，`requires_payment_method=true` |
| 税费模式 | 保留用户原配置 `location` |

最终配置符合用户最新的月付订阅要求。脱敏读回记录位于 `artifacts/paddle/sandbox-prices-verified.json`。产品上的 `app`、`checkout_intent_id` 可以留空，真实结账编号应写在逐笔交易上。

已建立 Git 忽略的本地 `.env.paddle.sandbox`，存放沙盒凭据与上述 ID。该文件供独立沙盒联调工具使用，不会被现有业务后端自动加载，也未启用生产收款。

开始真实 API／结账联调先准备 **Developer tools → Authentication** 中的 Sandbox API key 和 Sandbox client-side token（`test_...`），填入该文件的 `PADDLE_API_KEY`、`PADDLE_CLIENT_TOKEN`。本项目拟使用的 API key 权限如下；写权限已经包含同实体的读权限：

| 权限 | 用途 |
| --- | --- |
| `product.read`、`price.read` | 核对产品与套餐配置 |
| `transaction.write`、`customer.write` | 创建绑定平台账户的沙盒客户与结账交易，查询结果 |
| `subscription.read`、`notification.read` | 核实订阅状态与查询事件 |
| `customer_portal_session.write` | 提供订阅管理入口 |
| `price.write`，配置阶段使用 | 修正周期、创建无试用价格；包含 `price.read` |
| `notification_setting.write`，如由 API 配置回调 | 创建／更新沙盒通知目标并取得验签密钥 |
| `subscription.write`，如调试直接 API 取消或变更 | 修改沙盒订阅；包含 `subscription.read` |

完整闭环还需可访问的结账页、可接收 Paddle 请求的公网 Webhook URL，以及该通知目标的 `endpoint_secret_key`（填入 `PADDLE_WEBHOOK_SECRET`）。沙盒默认付款链接可以使用 `localhost`；Webhook 可通过独立测试域名或临时 HTTPS 隧道接入隔离测试服务。页面与接收接口实现后再填写实际 URL、创建 **Developer tools → Notifications** 的目标，避免先登记不存在的路径。通知密钥由 Paddle 为目标生成，与 API key、client token 分开。

完整业务验证范围为试用开启与 30 页发放、转付费与 300 页发放、取消、扣款失败、重复及乱序通知，以及已试用账户使用无试用价格。真实沙盒结账、模拟事件与本地契约检查分别记录。已完成价格配置、独立回调通路验证及权益契约检查；真实结账验收状态见第 11 节。

依据：[API 权限](https://developer.paddle.com/api-reference/about/permissions/)、[默认付款链接](https://developer.paddle.com/build/transactions/default-payment-link/)、[通知目标](https://developer.paddle.com/webhooks/about/notification-destinations/)、[Webhook 密钥](https://developer.paddle.com/webhooks/about/signature-verification/)。

## 10. Cloudflare 临时隧道与沙盒回调探针（历史通路验证）

早期通过本机 Cloudflare 临时 HTTPS 隧道与独立投递探针验证通路。2026-09-17 已删除该探针及独立测试，只保留 [完整沙盒服务](../scripts/paddle_sandbox_server.py) 与正式业务 Webhook，实现和验证入口见第 11、12 节。

历史探针记录位于忽略的 `artifacts/paddle/webhook-receipts.sqlite`，只用于证明当时投递与验签通路，不能作为权益结算证据，也不会导入业务库。

已通过 API 创建通知目标：

| 字段 | 当前配置 |
| --- | --- |
| Description | `NodeLane Comics Sandbox - local Cloudflare` |
| ID | `ntfset_01m2n6emrf9vsexb9ytwhmn00q` |
| Notification type | Webhook（API `type=url`） |
| URL | 本地 `.env.paddle.sandbox` 的 `PADDLE_WEBHOOK_URL`；同时记录于 `artifacts/paddle/notification-destination.json` |
| API version | 1 |
| Usage type | 平台和模拟事件（API `traffic_source=all`），仅用于隔离沙盒 |
| 敏感字段 | 关闭 `include_sensitive_fields` |
| 事件 | 全部 8 种 subscription 事件；transaction 的 completed、payment_failed、past_due、canceled；adjustment 的 created、updated |

通知目标 secret 已直接存入 Git 忽略的本地配置，无需再次手动创建目标。临时隧道依赖本机进程存活，重启后域名可能改变；更新目标时应编辑同一通知目标的 URL，不重复创建。生产业务处理器不得将模拟事件用于发放真实权益。

从仓库根目录可重复运行本地服务与检查：

```powershell
backend/.venv/Scripts/python.exe scripts/paddle_sandbox_server.py
# 在另一个终端运行；已有服务运行时不要重复启动。
artifacts/paddle/tools/cloudflared-windows-amd64.exe tunnel --url http://127.0.0.1:18764 --no-autoupdate --protocol http2
```

运行要求：现有后端 Python 虚拟环境（FastAPI、uvicorn，测试还需 httpx）及 cloudflared。当前 cloudflared `2026.9.1` 从 [Cloudflare 官方发行页](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1) 下载 Windows amd64 程序，Apache-2.0，SHA-256 `2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712` 已与发行资源 digest 比对；许可及来源记录位于 `artifacts/paddle/tools/`。

本机默认 DNS 无法解析 tunnel 的 SRV 记录；本次用 `Resolve-DnsName region1.v2.argotunnel.com -Type A -Server 1.1.1.1` 获取官方边缘地址，并为该临时进程增加 `--edge 198.41.192.67:7844 --no-prechecks` 完成连接，未修改系统 DNS 或关闭 TLS 验证。该地址是本次查询结果，后续不可假定永久有效。后台进程 ID 记录于 `artifacts/paddle/processes.json`。

历史验证结果：当时探针的 8 项本地测试通过；Paddle 模拟器实际经隧道投递 `subscription.trialing`、`transaction.completed`、`subscription.canceled`，三项均返回 HTTP 200 且在本地生成已验签回执。结果见 `artifacts/paddle/webhook-verification.json`。未发起真实用户绑卡、真实付款或权益发放。客户端月付说明通过 TypeScript／模块检查与 Chrome 桌面、390px 窄屏检查，截图位于 `artifacts/paddle/plus-monthly-*.png`。

## 11. 业务权益接入与当前验收

当前支付迁移为 `results_0001`，直接创建当前支付表及独立订阅权益字段。此前支付表结构不提供升级兼容；旧支付沙盒需新建隔离数据库。启用需设置 `.env.example` 中全部 `PADDLE_*` 配置；沙盒只允许隔离的 development/test 服务，生产禁止使用沙盒密钥。API 和维护服务必须使用相同配置及数据库。

已实现的接口与职责：

| 接口 | 职责 |
| --- | --- |
| `GET /v1/billing/status` | 登录账户的试用资格、待结账和订阅状态 |
| `POST /v1/billing/checkouts` | 服务端决定试用或无试用价格，创建／恢复唯一结账意图 |
| `POST /v1/billing/sync` | 核对 Paddle 当前资源并刷新账户权益 |
| `POST /v1/billing/cancel` | 取消当前账户的下期续费，保留已获得的当期权益 |
| `POST /v1/billing/portal` | 当前账户的 Paddle 客户门户临时链接 |
| `/billing/checkout` | 网页托管结账；插件只打开链接，不加载远程 SDK |
| `POST /webhooks/paddle` | 原始请求体验签、事件去重持久化、后台核对及发放 |

结账链接传递两小时有效的随机令牌，数据库只存哈希，页面读取后从地址栏移除；不传递账户登录 JWT。`_ptxn` 付款链接同样由 Paddle.js 承载，前端完成回调不能授予权益。API POST 结果未知时保留原意图并查询核实，不盲目重建交易。

权益核对同时检查原始后端交易、客户、订阅、产品、单件数量、USD 9.99 月付价格。试用仅发一次 30 页；已完成且有实际应付金额的完整月账期发 300 页；重复和乱序通知不会重置已用或预占。普通“已激活”事件不足以证明付款，未核实付款的账期不发额度。维护服务的独立线程恢复持久化失败事件，并每五分钟补查活跃订阅及近两天的待结账，Paddle 延迟不阻塞翻译任务恢复。超过两天仍未知的创建意图保留给人工核实，不自动产生新付款。

`ntfsimevt_` 模拟器事件只保存投递记录，不发业务权益。退款／争议尚无业务规则，相关 adjustment 回执标记 `MANUAL_REVIEW_REQUIRED`，不擅自撤销已使用额度；正式收费前必须完成规则及处置流程。

本机复现（仓库根目录，凭据仅位于被忽略的 `.env.paddle.sandbox`）：

```powershell
backend/.venv/Scripts/python.exe scripts/paddle_sandbox_server.py
# 使用上节的 Cloudflare 命令，仍指向 127.0.0.1:18764。
# 插件的 API 地址配置为 http://127.0.0.1:18766。
cd backend
.venv/Scripts/python.exe -m pytest tests/test_paddle_billing.py -q
```

该脚本使用独立 `artifacts/paddle/billing-runtime/sandbox.sqlite`，不启动图片模型或翻译节点。18766 仅为本机完整开发 API；18764 只开放结账页、公开支付配置、随机令牌结账会话和验签回调。现有临时地址为 `https://edward-groups-known-plasma.trycloudflare.com`，已经验证结账页 HTTP 200、公开开发登录 HTTP 404。完整后端替代上节探针运行；无需重新创建通知目标。

沙盒设置还需在 **Checkout → Checkout settings → Default payment link** 保存 `https://edward-groups-known-plasma.trycloudflare.com/billing/checkout`。本次真实创建交易 API 明确返回 `transaction_default_checkout_url_not_set`，即使请求指定 `checkout.url` 也要求先完成此商户设置。当前浏览器工具连接故障，已请用户保存此项；尚未把本地契约测试描述为真实绑卡验收。

本地支付契约 16 项通过，覆盖重放不增额、试用转付费、月度续费、未付款不发、取消保留期限、跨账户管理拒绝、未知交易恢复不重建、退款之外的独立赠送／补偿、过期试用任务释放原桶、漏回调补查及签名校验。扩展 236 项测试、类型／模块检查与生产构建通过。新增结账与订阅操作尚未完成真实浏览器视觉验收；此前第 10 节截图只证明旧说明界面。

完整业务接收器的在线通路已另行验证：Paddle 模拟事件通过现有 HTTPS 隧道投递成功，业务库记录 `ignored / SIMULATION`，额度桶数量保持 0；见 `artifacts/paddle/business-webhook-verification.json`。这验证了业务接收器的实际验签与模拟事件隔离，仍不替代真实绑卡测试。

最终本地回归：后端 505 项通过、86 项按环境条件跳过（包含 16 项支付和 2 项新旧库迁移）；扩展 236 项、独立后台 5 项测试通过，扩展类型／模块检查及两端构建通过。PostgreSQL 和需外部资源的跳过项不记为已验证。

## 12. 增量对账与公共实现

2026-09-17：删除旧投递探针及独立测试，验签只保留正式 `paddle_client.valid_signature`。完整沙盒服务使用正式 `billing_sync.run`，保留独立数据库与公开路由限制；结账地址必须显式配置，不再从旧 Webhook 配置推导。

当前结构在 `results_0001` 一次创建，包含 `billing_transactions`（交易 ID、所属订阅、已处理的上游更新时间、处理时间）和 `billing_subscriptions.transactions_synced_at`。删除了旧支付数据的独立升级迁移与测试，不读取或回填旧支付记录。回执不保存客户信息或原始支付报文；新订阅第一次对账时进度为空，进行完整分页扫描。交易严格使用 `details.totals.grand_total` 与 `updated_at`，试用严格使用 `items[].trial_dates`，缺少必需字段拒绝处理，不用旧字段兜底。

- 列表请求使用 Paddle 支持的每页 30 笔与 `id[ASC]` 排序，按 `has_more` 和 `after` 取完所有页。未知结账恢复共用这一分页实现，并按本地创建时间前五分钟起查找，覆盖时钟偏差，避免全商户历史扫描；发现多个匹配继续保持未知状态，不创建另一笔付款。
- 订阅首次扫描完整已完成交易，之后按 `updated_at[GTE]` 查询上次扫描开始时间前五分钟以来的变化。旧交易后来完成也会被补查；包含边界并保留重叠窗口，容忍五分钟以内的时钟偏差及列表可见性延迟，部署时需保持 UTC 时钟同步。这一进度只在所有页成功后推进，且并发扫描不能使其回退。
- 同一页在用户锁内一次提交交易回执与额度变更，网络请求不持有用户锁。按交易 ID 和上游 `updated_at` 跳过相同或更旧版本；同页多笔新账期只在末尾重算一次会员期限。分页失败时已提交页可保留，下次通过回执跳过；当前页异常则额度和回执一起回滚。
- 单笔交易通知仍向 Paddle 查询最新交易。若该版本已经处理，不再重复请求订阅和结算额度；订阅状态由订阅通知与周期补查维护。增量优化保留原有价格、付款、取消和退款策略。

分页与更新时间过滤依据：[交易列表](https://developer.paddle.com/api-reference/transactions/list-transactions/)、[游标分页](https://developer.paddle.com/api-reference/about/pagination/)。

验证命令（隔离 SQLite、HTTP MockTransport，不调用真实 Paddle）：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_paddle_billing.py tests/test_billing_reconciliation.py tests/test_paddle_client.py tests/test_request_limits_migration.py tests/test_membership.py tests/test_membership_days.py tests/test_billing_postgres.py -q
```

HTTP 模拟执行正式客户端，按官方规则过滤、排序并限制每页 30 笔，不再用直接返回所有交易的 Python 函数替换客户端。覆盖 66 笔历史的三页补查、早先创建的交易后续完成、相同时间戳、新旧上游版本、失败回滚、分页中断恢复、重复通知免额度查询、并发不重复发放及当前表结构创建。`test_billing_postgres.py` 复用专用 `nodecomics_concurrency_test` 数据库与随机 schema；启用方法同后端 README 的 PostgreSQL 并发套件。本机未配置该测试库且 Docker 未运行，真实 PostgreSQL 并发验证仍未完成。

本轮上述后端定向回归 68 项通过、3 项 PostgreSQL 用例因环境未启用而跳过；文档本地链接与 `git diff --check` 通过。旧探针测试已删除，其历史通过数量不计入本轮结果。

本轮未启用生产支付，也未完成真实绑卡验收。上次审查的余额抵扣结清判定、管理端重新登录丢失未知赠送幂等键、超过两天结账的自动补查截止及退款／争议处置，仍需单独修复或确认规则；本轮仅处理代码重复、对账重复与相关分页问题。
