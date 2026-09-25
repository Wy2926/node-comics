# 服务端管理后台

独立 React + TypeScript + Vite 后台提供供应商、异常任务、用户权益、支付、反馈、审计与诊断入口。服务端入口由私有环境变量 `ADMIN_WEB_PATH` 配置；旧 `/admin`、`/admin/` 及其资源返回 404，首页不跳转后台。实现面向当前模型与全新数据库，不增加旧队列、旧点数或旧数据适配逻辑。

## 页面与统计口径

| 页面 | 信息与操作 |
| --- | --- |
| 运行概览 | 当前在途、排队等待、有效执行租约、近 24 小时完成和失败；常规／重绘分别按上传、排队、运行、待核实统计；实时／预存、阶段积压、用户和资源概况 |
| 翻译任务 | 任务／用户名搜索、模式／状态／优先级／用户／节点筛选；执行履历、文本计量、分页供应商调用；未知结果确认失败、关联已有结果、补交译图 |
| 计算节点 | 图像计算节点与控制资源池、设备、引擎版本、能力、启停状态、心跳、执行位占用、过期租约，以及近 24 小时阶段次数／耗时；跳转参与任务 |
| 翻译供应商 | 文本 LLM 创建、配置、密钥替换、启停、默认切换及独立 RPM；版本历史位于运行诊断 |
| 图片供应商 | AI 重绘连接、模型、环境密钥引用、白名单与输入限制；启停、验证状态、真实图片测试及测试任务关联 |
| 用户管理 | 用户与当前权益；运营会员开通／续期／提前结束、限时赠送、当期补偿；历史额度桶、账本、预占任务和操作人／原因分页 |
| 系统设置 | 每日／会员默认额度、普通／PLUS 调度权重、滚动分钟准入、上传并发／超时／占位及反馈预算；版本冲突保护和变更审计 |
| 产品与价格 | 产品权益、月付／年付价格及 Stripe／Creem 渠道绑定；验证平台商品后发布，支持草稿、发布与停售，新价仅影响新订阅 |
| 订单管理 | 全渠道订单筛选与分页；原价格、结账、订阅、流转和通知；逐笔退款／争议及退款完整性核对；按所选历史订单定向核实 |
| 订阅与权益 | 订阅与客户列表、跨渠道试用已使用／在途占用；订阅详情串联账单、实际授权期和月度额度桶 |
| 支付事件 | 全局事件、异常、处理次数、接收时间、平台资源和关联订单；带原因、状态冲突与冷却保护的重新入队 |
| 翻译反馈 | 状态／问题／用户／任务筛选；关联真实生成或复用版本；处理人、备注、乐观冲突检查及分页历史 |
| 运行诊断 | 服务健康、用户准入、上传会话、提交回执、图片、文件页、生成版本、结果授权及文本供应商历史版本 |
| 用量与成本 | UTC 日期下的任务终态与平均总耗时、文本调用及未知预占、新增复用授权、按渠道／环境／币种／状态汇总的订单原金额 |
| 操作审计 | 操作者、动作、目标类型／编号、时间筛选与分页；脱敏前后值、备注和关联业务信息 |

`<ADMIN_WEB_PATH>#billing` 先创建产品，再添加月付／年付价格，最后关联支付渠道。金额填写实际金额，例如 USD 9.99；API 使用币种最小单位。价格默认草稿，至少一个渠道验证启用后才能发布；Creem 首次试用需分别关联常规和试用产品。调价复制为新价格，更新权益供后续价格选用；已有订阅及在途结账继续原价。`#orders` 显示订单流转及最近支付通知，结果未知且缺少结账编号时，可填入平台编号核实恢复。完整表结构、状态、年度额度规则及隔离浏览器复现见[多渠道订阅设计](STRIPE_BILLING.md)。

- **在途页数**：`awaiting_upload / validating_upload / queued / running / outcome_unknown`。
- **排队等待**：任务状态为 `queued`；“最早提交已等待”从这些任务最早的创建时间计算。已开始任务的阶段间等待需结合阶段积压与任务详情查看。
- **阶段积压**：按 `JobStage` 状态统计。一个任务可能有多个阶段，待执行包含退避和暂时不满足资源条件的阶段，不等于可立即领取的页数。
- **总耗时**：任务创建至结束，未结束则至当前时间。
- **首次等待**：任务创建至首次租约领取，尚未领取则至结束／当前时间。包含首次上传等待。
- **执行占用**：租约时间区间的并集，文本翻译与背景修复并行时不重复累计；已过期租约截止到过期时间。它包含阶段内部的网络、存储与处理，不等于模型纯推理耗时。
- **非执行时间**：总耗时减执行占用，包含上传、排队、阶段间等待和恢复间隔。
- **交付节点**：当前整页协议下，成功交付及无文字任务取成功的 page／redraw 租约。所有参与节点和重试都保留在执行履历。缓存复用只创建结果授权，不新增计算任务，也不进入本任务列表。
- **控制资源池**：`control-text / control-redraw / control-validate_upload` 是共享执行容量。控制工作进程领取时写入 `executor_id=hostname:pid`，任务详情可定位执行机／进程。图像节点直接记录其注册 ID。
- **过期租约**：单独标记为待回收，不显示成有效执行；回收前仍占资源容量。
- **最近提交**表示最近任务创建时间；系统未记录用户最后登录或当前在线状态，后台不会据此推断。
- 时间按浏览器本地时区显示。监控列表默认每 15 秒刷新，可暂停；后台标签页隐藏或详情打开时停止监控列表定时刷新。产品和订单页面手动刷新。请求失败保留上次数据并标记可能过时，支持重试；产品数据读取失败时禁用修改，刷新成功后恢复。

`<ADMIN_WEB_PATH>#translation-providers` 管理文本 LLM，`#image-providers` 管理图片重绘，二者配置与测试分别执行。文本配置说明见 [LLM 翻译供应商](TRANSLATION_PROVIDERS.md)。页面路由还包括 `#subscriptions / #billing-events / #feedback / #operations / #statistics / #audit`。表结构以[初始迁移](../backend/migrations/versions/0001_translations.py)和模型为准，不另维护表数／字段数快照。

### 处理操作与恢复

- 图片供应商保存／启停不会调用模型；真实测试会向所选供应商发送图片、产生供应商费用并使用当前管理员个人重绘权益，页面要求确认。测试请求保留原操作键与文件哈希，结果未知时先核实原任务。
- 任务详情先展示结算影响。确认失败释放原预占；成功核实结算原预占，已释放的迟到结果不重新扣页。关联结果必须属于原用户，不能改型其他任务／文件页／复用授权引用的图片；补交只是登记已生成译图，不再次调用模型。
- 用户权益操作均需原因。新会员月额度留空采用服务端受理时的默认规则；已有会员续期保留原额度。提前结束仅影响运营会员，付费订阅与独立限时赠送保留各自规则；当期补偿沿用原桶到期时间。
- 反馈处理要求原状态、原更新时间及操作编号；冲突时刷新再决定，原请求重放不会多写历史。会员、反馈、任务核实和支付事件重试均提供回包未知时恢复原操作的入口。
- 支付事件人工重试只重新入队既有事件，先核对渠道环境及处理次数；处理中或已完成事件不能重复入队，一分钟内最多一次人工重试。本站不提供发起退款或争议举证。
- 订单退款明细分别显示平台累计退款、已记录成功金额和完整性；缺失金额不是零。历史订单核实使用所选订单的渠道／订阅／交易／结账关联。

### 系统规则

| 设置字段 | 生效边界 |
| --- | --- |
| `free_daily_pages` | 新建每日额度桶采用新值；已有桶的授予、已用和预占不回写 |
| `plus_monthly_redraw_pages` | 新运营会员段的默认月额度；显式自定义仍有效，已有会员续期保留原快照 |
| `free_scheduler_weight` | 普通用户后续领取执行时使用；不增加页数或分钟名额 |
| `plus_scheduler_weight` | PLUS 后续领取执行时使用；已领取租约保留原权重用于结算 |

这些字段与既有请求保护规则保存在同一版本化 `system_settings`。环境变量只初始化缺失配置，重启不覆盖数据库设置；系统设置 PUT 必须带完整字段和 `expected_version`。付费产品权益仍来自不可变版本，见[系统设置](SYSTEM_SETTINGS.md)与[会员设计](MEMBERSHIP_AND_QUOTAS.md)。

## 运行与构建

前端源码：`backend/admin-ui/`。本机需要 Node.js 22+、npm，后端环境要求见 [backend/README.md](../backend/README.md)。

```powershell
cd backend/admin-ui
npm ci
npm run check
npm run build
```

构建输出到 `backend/app/admin_web/dist/`，已被仓库忽略。API 进程托管 HTML 和打包资源；同源访问，无需额外管理站点或运行 Node.js 服务。资源使用相对路径，改入口只需重启 API，不需重新构建。开发预览可运行 `npm run dev`，访问 `http://127.0.0.1:5175/`，默认代理 API `http://127.0.0.1:18088`，可用 `ADMIN_API_ORIGIN` 指定本地测试服务。Vite 开发服务器不用于验证生产入口限制。

### 私有入口配置

`ADMIN_WEB_PATH` 为空或未设置时关闭后台页面，API 和客户端登录仍可用。启用时设置单层路径，必须以 `/` 开头和结尾，中间为 2–80 位英文字母、数字、短横线或下划线；`admin`、`v1`、`internal`、`health`、`docs` 等保留名不可使用。建议生成随机入口后保存在对应私有环境文件，不写进仓库或公开页面：

```powershell
python -c "import secrets; print('ADMIN_WEB_PATH=/console-' + secrets.token_hex(16) + '/')"
```

本地 Compose 使用 `deploy/.env.local`，生产 Compose 使用 `deploy/.env.production`，服务器 Compose 使用 `deploy/.env.server`。开发引导脚本只在本地配置缺少该项时生成，重启不轮换；生产入口需显式配置。无尾斜线的新入口会补齐尾斜线并保留回调查询参数。

页面路由不进入 OpenAPI，`/v1/auth/config` 不返回入口。知道路径仍能加载登录页，管理员权限始终由服务端校验。更换入口后，旧入口不保留别名；已开始的后台登录需要重新发起。

容器构建 `docker build -t node-comics-backend:local backend` 自动完成前端构建并复制到最终 Python 镜像。数据库仅保留 `translations_0001` 全新空库基线，包含翻译请求、审计、反馈处理、退款和争议结构，不升级旧库。API 与工作进程应使用同版本代码。

### 登录

生产沿用现有 OIDC 授权码 + PKCE。身份服务需要登记精确回调地址 `https://<服务域名><ADMIN_WEB_PATH>`（包含尾斜线），允许前端从该域名访问 token endpoint；配置沿用 `OIDC_CLIENT_ID / OIDC_AUTHORIZATION_ENDPOINT / OIDC_TOKEN_ENDPOINT / OIDC_AUDIENCE`。管理员角色以服务端的 `OIDC_ADMIN_ROLE` 为准。前端使用当前 origin + pathname 作为回调，授权与换令牌保持一致，并保留 state、PKCE、时效及回调路径检查。

上线顺序：先在 Logto **新增**新后台回调，保留插件的 `https://aiajdjliifeeaogpalejpggkiccjbneo.chromiumapp.org/oidc` 及其他客户端回调；再发布代码、配置 `ADMIN_WEB_PATH` 并更新 OpenResty；真实后台登录成功后移除旧 `/admin/` 回调。仅更换路径时不修改 Client ID、Issuer、Audience、授权／令牌端点或 CORS 来源。

`DEV_AUTH=true` 时显示开发用户名登录，管理员用户名由 `DEV_ADMIN_USERNAME` 配置。公开服务必须关闭开发登录。访问令牌仅保存在当前浏览器标签页会话，退出后清除。服务端每个监控接口都校验管理员权限，普通账户返回 403；静态登录页可公开加载。

## 接口与数据边界

监控 GET 路由在 `/v1/admin/monitor` 下：

- `/overview`：全局快照、当前队列与近 24 小时统计。
- `/tasks`：默认 25 条、上限 100 条，支持 `q / mode / status / priority / owner_id / node_id / offset / limit`。
- `/tasks/{id}`：任务执行详情。
- `/nodes`：节点和资源池运行信息。
- `/users`：用户分页，支持 `q / plan / offset / limit`。
- `/users/{id}`：用户权益与实际阅读会话摘要。

管理接口按业务归属注册：

| API 前缀 | 路径与用途 |
| --- | --- |
| `/v1/admin/providers` | 列表、PUT 配置、PATCH 启停、`/{id}/test` 真实图片测试 |
| `/v1/admin/jobs/{id}` | `/attempts` 分页履历；`/reconcile` 核实；`/reconcile-image` 补交 |
| `/v1/admin/users/{id}` | `/membership / quota-grants / quota-compensations` 业务操作；`/quota-periods / usage-ledger / membership-operations / reserved-jobs` 历史分页 |
| `/v1/admin/feedback` | 列表、`/{id}` 详情／处理、`/{id}/reviews` 历史分页 |
| `/v1/admin/billing` | `/orders` 与定向 reconcile；`/events` 及详情／retry；`/subscriptions` 及详情／invoices／terms；`/customers / accounts/{id}` |
| `/v1/admin/operations` | `/health / users/{id} / uploads / receipts / assets / file-pages / results / accesses / statistics` |
| `/v1/admin/translation-providers/{id}/revisions` | 文本供应商配置版本分页，不回显密钥 |
| `/v1/admin/audit` | 管理动作分页检索，仅显示脱敏元数据 |
| `/v1/admin/system-settings` | GET 当前版本，PUT 完整配置及预期版本 |

监控与诊断 GET 只读取数据库元数据，不访问 R2、不调用供应商、不改变队列或结算；状态“有效”不等于已探测对象存在。管理写操作和平台核实按各自业务产生副作用并记录审计。不向页面发送节点令牌、供应商密钥、图片、OCR 或译文全文；反馈评论和管理员处理备注属于有权限的业务记录。

除支付管理模块使用 `page / page_size` 外，新增历史和诊断列表使用 `offset / limit`，每页上限 100。审计记录操作者、目标、前后值、原因与时间，同事务写入；回滚业务不留下成功审计。令牌、密钥、对象路径、签名地址、OCR／译文载荷不写入审计快照。

统计取最近 1–90 天并按 UTC 日期汇总。供应商／模型筛选仅作用于文本调用表；最多返回 2000 个分组并显式标记截断。文本金额含估算／未知消耗预占，不是已对账费用；新增复用授权不是阅读浏览次数；订单原金额按币种分列，不作为净收入。服务健康只提供当前实例与积压，历史告警和消息通知未建设。

## 匿名网站申请与插件反馈

插件漫画网站页和通用反馈窗无需登录，网站入口来自适配器注册元数据与随包图标。管理员分别查看网站申请和插件反馈，不公开联系方式。

- `POST /v1/support-requests`：`kind=website|plugin`，UUID `Idempotency-Key`；网站申请要求名称与公开 HTTP(S) 地址，插件反馈要求正文。名称／URL／说明／联系方式上限分别为 100／2048／1000／200 字符，联系方式可选且不限定邮箱。请求体最多 16 KiB。
- 网站地址拒绝凭据和本地地址，去除 query／fragment；服务端只保存，不抓取。重复原请求不新增记录，同编号改内容为 409。未知回包冻结原草稿与编号重试，已知拒绝允许修改。
- `GET /v1/admin/support-requests?kind=website|plugin&offset=0&limit=25` 仅管理员可读，按时间和 ID 倒序分页。两类共享匿名限流：对端地址摘要每 60 秒新增最多 5 条、UTC 日 20 条，重放不计；429 返回 `Retry-After`，转发地址只接受可信代理配置。
- `support_requests` 与 `support_request_admissions` 属空库初始基线。正文、联系方式、原网络地址不写默认日志；公开回执仅含 `id` 与 `created_at`。

契约回归在 `backend/tests/test_support_requests.py`；隔离预览按后端运行文档准备 Python 依赖后，在 `backend` 执行 `python tests/support_preview.py --lose-first-response`，在插件目录以 `VITE_API_BASE=http://127.0.0.1:18089` 启动 Vite 5191。访问插件 `/#sites` 和后台 `/console-fixture/`（测试用户名 admin）；夹具创建临时库并模拟首次回包丢失，不访问外部服务。正式构建前清除 `VITE_API_BASE`。

## 验证

后台从 `backend/admin-ui` 执行 `npm ci`、`npm run check`、`npm test`、`npm run build`；后端与专用 PostgreSQL 环境见[后端说明](../backend/README.md#验证)。检查管理员隔离、重复写入／未知回执恢复、审计同事务、订单定向核实，以及页面加载、空结果、失败和重试。

### 隔离浏览器

先构建后台，然后在一个终端运行服务：

```powershell
cd backend
$env:ADMIN_FIXTURE_PORT = '18096'
.venv/Scripts/python.exe tests/manual_admin_completion_server.py
```

在另一个终端，从仓库根目录运行下列命令。两个路径使用服务启动时打印的临时路径，不要指向其他图片或环境文件。验收脚本要求 Chrome 和可导入的 Playwright；也支持 Codex 自带的 Node 运行时依赖。

```powershell
$env:ADMIN_COMPLETION_IMAGE = '<启动时打印的 ADMIN_COMPLETION_IMAGE>'
$env:ADMIN_FIXTURE_CONTROLS = '<启动时打印的 ADMIN_FIXTURE_CONTROLS>'
node scripts/verify_admin_completion.mjs
```

脚本会修改合成数据，每次复验先重启夹具以重建空库。报告和截图写入已忽略的 `artifacts/admin-completion/`；`controls.json` 的 `lose_receipt` 会在业务事务成功后模拟一次 503，验证不确定回包恢复。该机制仅存在于独立验收服务。

PostgreSQL 专项使用 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / TEST_PG_PORT / TEST_PG_USER / TEST_PG_PASSWORD`，运行 `test_admin_completion_postgres.py` 及既有支付／设置并发套件；测试固定限制在 `nodecomics_concurrency_test` 库，详见 `test_postgres_concurrency.py` 和 `deploy/compose.tests.yaml`。未启用的专用测试不计通过。

### 真实接入

真实图片供应商检查使用 `scripts/verify_image_provider_live.py`，结果未知先核实原请求；OIDC、支付、R2 与模型效果按目标环境分别验收。

## 前端依赖

实际版本由 `backend/admin-ui/package-lock.json` 固定，下载完整性由其中 `integrity` 校验。运行时 React / React DOM **19.3.0**（MIT）；构建 Vite **7.3.6**（MIT）、TypeScript **5.9.3**（Apache-2.0）。其余类型与构建插件以锁文件和包内许可为准。使用系统字体，无新增字体文件、模型权重、外部 CDN 或图片依赖。
