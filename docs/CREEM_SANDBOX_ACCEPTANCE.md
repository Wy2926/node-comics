# Creem 真实测试模式验收（2026-09-22）

本轮使用 Creem **test** API、官方测试卡及全新独立 PostgreSQL，运行当前源码；没有连接生产库、使用 live 密钥或真实扣款。没有修改支付生产源码。本轮新增可复用验收脚本与其安全回归测试，所有真实结果与模拟回归分别记录。

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

年付与试用最初使用的临时隧道因本机默认 DNS 无法查询 Cloudflare SRV 记录而退出，首次成功返回页出现 1033。没有据此重复付款；年付先经绑定订单 GET 恢复，随后 Creem 重投通知处理成功。改用独立 Docker 隧道容器的 DNS 与显式宿主映射后恢复，最终月付完整验证有效返回页。没有修改系统 DNS 或公开开发登录接口。

## 本轮自动检查

支付与验收脚本专项：**165 passed**（43.80 秒），均为本轮重新运行，包含新脚本 7 例。只出现已有 TestClient／AnyIO 弃用警告。

从 `backend` 目录执行：

```powershell
& .venv/Scripts/python.exe -m pytest -q tests/test_creem_sandbox_acceptance.py tests/test_billing_admin_completion.py tests/test_billing_admin.py tests/test_creem_billing.py tests/test_stripe_orders.py tests/test_stripe_billing.py tests/test_billing_catalog.py tests/test_billing_checkout_races.py tests/test_billing_default_provider.py
```

新脚本回归覆盖：live 密钥拒绝、限定 test 主机、未知 POST 先留持久标记且不重发、相同操作仅重放原结果、改变请求体拒绝、400 原因只存私密诊断、不自动重试，以及远端非 test 对象拒绝。其测试不访问网络。

PostgreSQL 专项：**46 passed**（90.33 秒），为本轮单次实际运行。使用同一独立 PostgreSQL 容器中的**另一个** `nodecomics_concurrency_test` 数据库；每例建立并清理随机 schema。供应商传输被模拟，真实沙箱数据库不会被回归测试修改。实际运行命令（从 `backend`）：

```powershell
& .venv/Scripts/python.exe -c 'import os,subprocess,sys; from dotenv import dotenv_values; cfg=dotenv_values("../private-test-data/creem-sandbox-20260922/postgres.env"); env=os.environ.copy(); env.update(RUN_POSTGRES_CONCURRENCY="1",TEST_PG_HOST="127.0.0.1",TEST_PG_PORT="55438",TEST_PG_USER="nodecomics",TEST_PG_PASSWORD=cfg["POSTGRES_PASSWORD"],TEST_PG_DATABASE="nodecomics_concurrency_test"); sys.exit(subprocess.call([sys.executable,"-m","pytest","-q","tests/test_admin_completion_postgres.py","tests/test_admin_monitor_postgres.py","tests/test_creem_billing_postgres.py","tests/test_billing_postgres.py","tests/test_system_settings_postgres.py","tests/test_billing_default_provider_postgres.py"],env=env))'
```

## 独立环境与复现

入口脚本为 [creem_sandbox_acceptance.py](../scripts/creem_sandbox_acceptance.py)。需要 Python 后端依赖、Docker，以及用户授权使用的 Creem test 密钥。密钥只从已忽略的 `private-test-data/admin-live/.env.creem` 的 `CREEM_API_KEY` 读取，不加载项目 `.env`。不要把文件内容或环境转储写进报告。

脚本固定本轮隔离名称，已有状态时 `init` 会拒绝重建：

- PostgreSQL 容器／持久卷：`nc-creem-sandbox-20260922`；数据库：`nodecomics_creem_sandbox_20260922`；仅监听 `127.0.0.1:55438`。
- API：`127.0.0.1:18098`，网关：`127.0.0.1:18102`；网关仅有验签的 `/webhooks/creem` 和静态 `/payment/success/`。
- 私密状态、操作收据、原始签名通知及测试日志：`private-test-data/creem-sandbox-20260922/`，均被 Git 忽略。
- Cloudflare 容器只访问宿主网关，不映射入站端口。实测版本 2026.9.1，镜像内容 ID `sha256:b269e8abd07a5bf6f3f4be65d5050b2174eca89c56a0241a8ff32a16aec454e4`。

新隔离环境准备命令（从仓库根目录；现有本轮数据应直接复用，不重置）：

```powershell
$python = (Resolve-Path backend/.venv/Scripts/python.exe).Path
& $python scripts/creem_sandbox_acceptance.py init
& $python scripts/creem_sandbox_acceptance.py catalog
```

以隐藏后台进程分别运行 `gateway` 与注册完成后的 `serve`，保存 PID 与日志到上述私密目录。可在受控终端前台运行对应命令调试；两者始终绑定 loopback。`serve` 包含实际应用和后台支付重试线程。仅网关可由隧道访问。

```powershell
# 先启动 gateway；用 Start-Process 时加 -WindowStyle Hidden，并将输出重定向到私密目录。
& $python scripts/creem_sandbox_acceptance.py gateway

# 独立 Docker 隧道。以下宿主地址来自本轮容器内实际解析，不应盲用其他机器地址。
docker run --detach --name nc-creem-webhook-tunnel-20260922 --label node-comics.acceptance=creem-sandbox-20260922 --dns 1.1.1.1 --add-host host.docker.internal:192.168.65.254 cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:18102 --protocol http2 --edge-ip-version 4

# 从该隧道日志取得本次 HTTPS origin。占位值须替换为实际返回值。
& $python scripts/creem_sandbox_acceptance.py register-webhook --url https://ACTUAL.trycloudflare.com
& $python scripts/creem_sandbox_acceptance.py serve
```

在别的终端生成指定的单一结账；脚本只输出本地跳转入口，不输出带签名回执或秘密。已发出的不确定请求不会自动重发。

```powershell
& $python scripts/creem_sandbox_acceptance.py checkout --scenario paid-year
& $python scripts/creem_sandbox_acceptance.py checkout --scenario trial-month
& $python scripts/creem_sandbox_acceptance.py checkout --scenario paid-month
```

依次在真实浏览器打开脚本返回的本地入口，确认页面显示“不进行真实支付”，使用官方测试卡及明显的测试身份完成相应流程。不要保存真实卡或输入真实付款资料。示例测试身份使用 `example.com`，不向真实邮箱发送验收信息。

```powershell
& $python scripts/creem_sandbox_acceptance.py status
& $python scripts/creem_sandbox_acceptance.py verify
# order-id 必须从该隔离库 status 输出中选择。
& $python scripts/creem_sandbox_acceptance.py verify-history --order-id ACTUAL_ORDER_ID
& $python scripts/creem_sandbox_acceptance.py refund --order-id ACTUAL_ORDER_ID
```

`refund` 只允许本轮专用年付测试账户的 paid 订单，并再次核实远端 test 交易。官方该接口只退全额剩余金额。成功回包、明确 HTTP 错误和未知结果均保留不同操作记录；失败后不要换一个操作名盲重发。余额不足需先解决平台条件，不能靠本地数据修改“完成”验收。

收敛时：

```powershell
& $python scripts/creem_sandbox_acceptance.py cancel-test-subscriptions
& $python scripts/creem_sandbox_acceptance.py status
& $python scripts/creem_sandbox_acceptance.py disable-webhook
```

核实 PID 对应本脚本后停止 `serve`、`gateway`；停止本次隧道和 PostgreSQL 容器，保留数据库卷。核对 loopback 端口无监听，并将关闭证明与脱敏验收报告保存在私密目录。不要停止其他项目的服务。

## 官方依据

- [Test Mode](https://docs.creem.io/getting-started/test-mode)：独立 test API、测试卡及无真实扣费边界。
- [商品读取](https://docs.creem.io/api-reference/endpoint/get-product)、[商品列表](https://docs.creem.io/api-reference/endpoint/search-products)：真实校验当前商品数据。
- [Webhook 注册](https://docs.creem.io/api-reference/endpoint/create-webhook)、[更新](https://docs.creem.io/api-reference/endpoint/update-webhook)、[签名与重投](https://docs.creem.io/skills/creem-api/WEBHOOKS)：HTTP 端点、HMAC-SHA256 验签及失败重试。
- [退款接口](https://docs.creem.io/api-reference/endpoint/refund-payment)：按 transaction ID 退全额剩余金额，支持异步 pending；没有据此推断部分退款或历史明细读取能力。
- [取消订阅](https://docs.creem.io/api-reference/endpoint/cancel-subscription)：只对本轮创建且再次核实为 test 的订阅执行清理。

本记录替代早期文档中“当前本地服务／隧道仍运行”的描述；历史验证结果仍保留原日期和边界，不与本轮通过数累加。
