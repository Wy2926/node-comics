# Creem 测试模式验收（2026-09-22）

历史验收记录：使用 Creem test API、官方测试卡和全新独立 PostgreSQL，未连接生产库或真实扣款。固定本次日期、容器和端口的一次性脚本及其专用测试已移除；业务回归保留，生产接入与隔离环境配置见[支付设计与验证](STRIPE_BILLING.md)。

## 真实观察与限制

| 场景 | 本轮实际结果 |
| --- | --- |
| 商品核实 | 真实 GET 核验既有四个 Node Comics PLUS 测试商品：月付 999／年付 9999 美分，以及各自 7 天试用商品；均为 test、USD、active。未创建或修改线上商品。 |
| 年付测试卡付款 | 真实托管页面显示测试模式；完成 US$99.99 测试付款，真实交易核实为 paid。12 个各 300 页额度桶，当前仅一个有效。 |
| 月付测试卡付款 | 完成 US$9.99 真实托管测试付款，交易 paid，1 个 300 页桶；实际返回临时 HTTPS 成功页，浏览器确认查询串已清除，并检查截图。 |
| 首次试用 | 独立账户完成真实托管试用，订单金额 0、订阅 trialing、周期精确 7 天，1 个 30 页额度桶。 |
| 真实签名通知 | 付款与试用共 7 条事件全部 processed、无最终错误；后续本轮 3 个测试订阅取消又收到 3 条通知，共 10 条全部 processed。包含 subscription.paid、checkout.completed、subscription.trialing、subscription.canceled。其中两条到达时关联信息尚未就绪，持久重试后成功。 |
| 原通知重复投递 | 保存真实到达的原始 body 与签名到忽略目录，再原样投递 7 条通知；事件 7、订单流转 13、账单 3、授权期 3、退款 0、额度桶 14 均未增加。 |
| 权限与伪造通知 | 普通测试账户访问管理订单返回 403；错误签名直接调用应用 Webhook 返回 401，数据库计数不变。公开隧道不代理管理 API，相关请求返回 404。 |
| 历史订单定向核实 | 在独立库加入一个明确合成、未向外发起的新 checkout 作为错误目标检测，然后核实真实年付旧订单。实际 HTTP 读取追踪确认查询旧订单绑定的真实 subscription 与 transaction，没有访问较新 checkout；合成记录随后清理。真实渠道读取与合成检测条件分别标识。 |
| 退款 | 对本轮年付 test 交易按官方全额退款接口发起请求，明确返回 HTTP 400：商户余额不足，需要等待后续收入。随后 GET 仍为 paid；一次用于保留明确错误诊断的重试再次返回同一 400。此后没有继续提交退款或为增加余额而创建付款。没有 refund.created 成功通知，也没有伪造退款明细。 |
| 结束与清理 | 本轮 3 个 test 订阅均经真实 GET 确认为 canceled；本次创建的 test Webhook 经 GET 确认为 disabled。独立数据库和证据保留，临时 API、网关及隧道停止。 |

退款成功后的明细入库、真实重复部分退款、争议、自然续费、真实拒付、OIDC 和生产收费仍未在本轮完成真实验收。退款与争议状态及重复／乱序边界仅有隔离模拟和 PostgreSQL 回归证据；不能将它们记为真实资金链路通过。取消订阅也不等于退款：两笔付费订单仍保留 paid 的实际财务记录。

## 自动检查与复验

当日支付专项 165 项、PostgreSQL 专项 46 项通过。165 项中包含已随一次性工具移除的 7 项工具测试，该历史总数不作为当前测试数量。

现有支付业务回归从 `backend` 执行，不访问真实支付平台：

```powershell
.venv/Scripts/python.exe -m pytest -q tests/test_billing_admin_completion.py tests/test_billing_admin.py tests/test_creem_billing.py tests/test_stripe_orders.py tests/test_stripe_billing.py tests/test_billing_catalog.py tests/test_billing_checkout_races.py tests/test_billing_default_provider.py
```

PostgreSQL 回归使用专用 `nodecomics_concurrency_test` 数据库和每例独立 schema；环境准备见[后台验收说明](ADMIN_CONSOLE.md#验证)及 `deploy/compose.tests.yaml`。真实测试商户操作须重新核实 test 环境、目标订单和回调配置，不能复用已关闭的临时隧道。

## 证据与清理

私密原通知、签名、收据和日志留在被忽略的 `private-test-data/creem-sandbox-20260922/`。独立数据库卷保留；API、网关、隧道和数据库容器已停止，三个测试订阅已取消，本次 Webhook 已禁用。最初隧道 DNS 故障曾导致返回页失败；未重复付款，绑定订单核实与通知重试后恢复，最后月付已验证正常返回。此记录不表示当前服务仍在运行。

## 官方依据

- [测试模式](https://docs.creem.io/getting-started/test-mode)
- [Webhook 签名与重投](https://docs.creem.io/skills/creem-api/WEBHOOKS)
- [全额退款接口](https://docs.creem.io/api-reference/endpoint/refund-payment)
- [取消订阅](https://docs.creem.io/api-reference/endpoint/cancel-subscription)
