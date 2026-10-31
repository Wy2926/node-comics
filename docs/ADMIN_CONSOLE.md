# 服务端管理后台

独立 React + TypeScript + Vite 后台提供供应商、任务、用户权益、支付、反馈、审计与诊断入口。服务端入口由私有环境变量 `ADMIN_WEB_PATH` 配置；保留路径 `/admin`、`/admin/` 及其资源返回 404，首页不跳转后台。

## 页面与统计口径

主导航只保留八个入口。订单内合并订阅、产品价格与支付事件；反馈收件箱合并翻译、插件、卸载、网站适配；额度活动、用量、健康和审计归入系统设置。

| 工作区 | 信息与操作 |
| --- | --- |
| 概览 | 近 24 小时正式订单实收原金额（分币种、退款前）、订单与异常数、待处理反馈、用户；最近订单和反馈待办优先，底部为翻译服务状态 |
| 用户管理 | 按名字搜索；点用户打开工作台，联查权益、任务、订单、订阅、反馈、准入诊断；运营会员、限时赠送与补偿保留原因和历史 |
| 订单管理 | 以用户、购买内容、金额和状态为主；订单详情联查通知、退款、争议和权益；子页管理订阅、产品价格、渠道与支付事件 |
| 反馈收件箱 | 四类反馈、待处理角标与即时提醒；打开处理抽屉，记录状态和备注；翻译反馈可直接查看用户与关联任务 |
| 翻译任务 | 用户、任务类型、状态、提交时间和 IP 所在国家；筛选与分页；执行履历和文本计量在详情查看 |
| 翻译供应商 | 创建与编辑连接；高级请求、分流和价格配置分组折叠；启停、套餐、权重、RPM；对已保存配置发送一次测试请求 |
| 计算节点 | 名称、能力、心跳、执行位、阶段耗时和配置；联查参与任务 |
| 系统设置 | 额度、提示词与预算；子页为额度活动、用量成本、服务健康和操作审计 |

用户和任务通过抽屉直接联查，关闭后保留原列表位置、筛选和用户页签。列表不再要求复制用户 ID 到其他页面输入；上传、资产、请求 UUID、结果等纯编号诊断列表及其专用接口已移除。必要技术编号仍保留在详情或审计。

`<ADMIN_WEB_PATH>#billing` 先创建产品并选择会员或额度包，再添加对应价格，最后关联支付渠道。会员产品的价格分别选择自动续费（月／季／年）或一次性会员（季／年）；季卡／年卡直接复用原 PLUS／Pro 产品及无试用权益版本，无需另建产品。额度包配置常规页数、有效天数（空为不过期）、已有会员服务档位及小时受理限制；不含试用和周期页数，只能创建 `onetime + once` 价格。金额填写实际金额，API 使用币种最小单位，不预设额度包售价。价格默认草稿，至少一个渠道验证启用后才能发布；Creem 首次试用需分别关联常规和试用产品，不自动续费季卡／年卡则分别绑定无试用的 onetime 商品。调价复制为新价格，更新权益供后续价格选用；已有权益及在途结账继续原价。`#orders` 显示订单流转及最近支付通知，结果未知且缺少结账编号时，可填入平台编号核实恢复。额度包订单显示原购买桶与已用／预占；一次性会员按原订单关联授权期和逐月额度。部分退款提示人工核定，不按金额自动折算页数或期限。完整表结构、状态、年度额度规则及隔离浏览器复现见[多渠道支付设计](STRIPE_BILLING.md)。

- **在途页数**：`awaiting_upload / validating_upload / queued / running / outcome_unknown`。
- **排队等待**：任务状态为 `queued`；“最早提交已等待”从这些任务最早的创建时间计算。已开始任务的阶段间等待需结合阶段积压与任务详情查看。
- **阶段积压**：按 `JobStage` 状态统计。一个任务可能有多个阶段，待执行包含退避和暂时不满足资源条件的阶段，不等于可立即领取的页数。
- **总耗时**：任务创建至结束，未结束则至当前时间。
- **首次等待**：任务创建至首次租约领取，尚未领取则至结束／当前时间。包含首次上传等待。
- **执行占用**：租约时间区间的并集，文本翻译与背景修复并行时不重复累计；已过期租约截止到过期时间。它包含阶段内部的网络、存储与处理，不等于模型纯推理耗时。
- **非执行时间**：总耗时减执行占用，包含上传、排队、阶段间等待和恢复间隔。
- **交付节点**：当前整页协议下，成功交付及无文字任务取成功的 page 租约。所有参与节点和重试都保留在执行履历。本人复用只增加指向同一 Job 的请求 UUID，不新增计算任务，也不进入本任务列表。
- **控制资源池**：`control-text / control-validate_upload` 是共享执行容量。控制工作进程领取时写入 `executor_id=hostname:pid`，任务详情可定位执行机／进程。图像节点直接记录其注册 ID。
- **过期租约**：单独标记为待回收，不显示成有效执行；回收前仍占资源容量。
- **文本调用计量**：单图和文件任务的每次 LLM 调用及重试分别显示输入／输出 Token 与成本。Token 读取已有供应商用量记录，0 与未提供区分；缺失用量不推算、不补记。成本按任务配置单价估算，未知消耗仍保留预占，不等同已核对账单。
- **最近提交**表示最近任务创建时间；系统未记录用户最后登录或当前在线状态，后台不会据此推断。
- 时间按浏览器本地时区显示。监控列表默认每 15 秒刷新，可暂停；后台标签页隐藏或详情打开时停止监控列表定时刷新。产品和订单页面手动刷新。请求失败保留上次数据并标记可能过时，支持重试；产品数据读取失败时禁用修改，刷新成功后恢复。

`<ADMIN_WEB_PATH>#translation-providers` 管理文本 LLM，显示正文适用套餐与两种用途的权重；正文按套餐内候选权重分配，漫画名显示全站预计比例。编辑可选择全部或指定正文套餐，页面提示未覆盖的套餐；权重设为 0 停止该用途的新分配。停用供应商还会暂停其已有正文任务。上游 RPM 独立于模型参数和用户业务限流，由两种用途的实际调用共享，修改不生成模型版本。思考程度默认 `none`，模型支持范围、套餐路由和版本规则见 [LLM 翻译供应商](TRANSLATION_PROVIDERS.md)。订单、反馈等业务子页可直接访问；旧 `#operations` 页面已删除，健康状态统一在 `#health`。表结构以[数据库迁移](../backend/migrations/versions/)和模型为准，不另维护表数／字段数快照。

### 处理操作与恢复

- `#quota-campaigns` 创建活动后先保持暂停，核对后启用。“调整期限”保留活动身份和领取记录，可选择仅影响后续发放或同步已到账额度；“复制新活动”会另发一份赠送，并按新创建时间划分新老用户。列表读取失败禁用配置；创建、启停和期限调整在发送前保留原编号、版本与参数，回执丢失后刷新页面仍可恢复原请求，版本冲突后重新读取并由管理员决定，退出登录清理会话内待核实操作。额度发放与有效期规则见[额度活动](MEMBERSHIP_AND_QUOTAS.md#可配置额度活动)。
- 用户权益操作均需原因。新赠送段每 30 天的常规额度留空表示不限量；续赠保留原规则、已用与预占。已有付费／试用期时顺延赠送，等待支付渠道确认时展示待安排；未来赠送也可提前结束。结束赠送不撤销已付款权益、不提前扣款日期，独立限时页数赠送与当期补偿保持各自规则。订阅详情显示自动续费意愿和预计恢复日期。
- 反馈处理要求原状态、原更新时间及操作编号；冲突时刷新再决定，原请求重放不会多写历史。会员、反馈和支付事件重试均提供回包未知时恢复原操作的入口。
- 支付事件人工重试只重新入队既有事件，先核对渠道环境及处理次数；处理中或已完成事件不能重复入队，一分钟内最多一次人工重试。本站不提供发起退款或争议举证。
- 订单退款明细分别显示平台累计退款、已记录成功金额和完整性；缺失金额不是零。历史订单核实使用所选订单的渠道／订阅／交易／结账关联。

`#settings` 管理单图结果保留天数、LLM 提示词和请求预算；字段、校验与生效范围统一见[系统设置](SYSTEM_SETTINGS.md)。付费产品权益见[会员规则](MEMBERSHIP_AND_QUOTAS.md)。

## 运行与构建

前端源码：`backend/admin-ui/`，组件采用 Ant Design，颜色、圆角、间距与控件尺寸集中在 `src/theme.tsx` 和 `src/admin.css`。本机需要 Node.js 22+、npm，后端环境要求见 [backend/README.md](../backend/README.md)。

```powershell
cd backend/admin-ui
npm ci
npm run check
npm run build
```

构建输出到 `backend/app/admin_web/dist/`，已被仓库忽略。本地 `SERVE_STATIC=true` 时由 API 托管页面；生产由 OpenResty 同源提供独立静态产物，不运行 Node.js 服务。资源使用相对路径，更换入口无需重编前端，但须同步应用配置、OIDC 回调和代理路由。开发预览可运行 `npm run dev`，访问 `http://127.0.0.1:5175/`，默认代理 API `http://127.0.0.1:18088`，可用 `ADMIN_API_ORIGIN` 指定本地测试服务。Vite 开发服务器不用于验证生产入口限制。

### 一条命令预览与打包

首次准备 Python 测试依赖（仅预览需要），然后启动后台热更新：

```sh
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-test.txt
npm --prefix backend/admin-ui ci
npm --prefix backend/admin-ui run demo
```

Windows 使用 `backend/.venv/Scripts/python.exe`。打开 `http://127.0.0.1:5175/`，开发用户名为 `admin`。脚本同时启动 Vite 和独立 SQLite / 内存 Redis 夹具，任务、国家、订单、反馈及模型响应均为合成数据，不连接生产或真实支付/LLM；Ctrl+C 停止两个进程。重新启动创建新的临时库。`ADMIN_PYTHON / ADMIN_FIXTURE_PORT / ADMIN_UI_PORT` 可分别覆盖 Python、API 端口（默认 18090）和前端端口。连接自己的本地 API 使用 `npm run dev` 与 `ADMIN_API_ORIGIN`。

只改前端时，独立构建并准备不可覆盖的静态发布目录：

```sh
npm --prefix backend/admin-ui run release -- \
  --release <版本> --destination <静态根绝对路径> \
  --nginx-root <代理可见的静态根绝对路径> \
  --admin-path <现有私有入口> --oidc-origin <身份服务HTTPS源>
```

这条命令复用 `prepare_static_release.py`，生成 `release.inc` 与静态文件，不切换线上入口。API / 数据库变化先按[部署规范](DEPLOYMENT.md)迁移与更新，再替换后台静态发布；入口和 OIDC 回调沿用现有配置。无需在生产运行 Node.js。Ant Design 动态样式需要 CSP `style-src 'self' 'unsafe-inline'`；脚本仍仅允许同源，不开放内联脚本。

### 任务 IP 与国家

单图和整本任务首次受理时保存 ASGI 已校验的对端 IP，重放和本人复用保持原任务来源。反向代理必须覆盖客户端提供的转发头，并且 API 仅信任指定代理；不直接采信请求中的 `CF-Connecting-IP` 等头。IP 仅出现在管理员接口，历史任务不回填或猜测。

国家在查询时用 `GEOIP_DATABASE` 指向的本地 MMDB 解析，支持 IPv4 / IPv6。一个分页请求只打开一次 mmap，按本页地址去重；不向外部服务发送 IP，不做无界缓存。缺库、无匹配、内网地址分别明确提示。国家代表当前数据库对提交 IP 的推断，VPN / 代理的出口所在地不等于用户实际所在地。

后台独立使用 DB-IP Lite City，Compose `.env` 设置 `GEOIP_DIRECTORY=/var/lib/nodelane-geoip`，应用 `.env.server` 使用 `GEOIP_DATABASE=/geoip/city.mmdb`。API 只读挂载整个目录；`scripts/update_geoip.py` 验证并原子更新后，下次查询自动使用新库。不依赖 NginxPulse 的地理解析或数据库。安装、权限、来源与许可记录统一见[管理后台 GeoIP 运维](OPERATIONS.md#管理后台-geoip)。地理数据来源：[DB-IP Lite](https://db-ip.com/db/lite.php)。

### 即时反馈与供应商测试

已登录且页面可见时建立一条带 Bearer 的 SSE 连接，复用现有数据库提交通知；四类反馈新增后显示提醒和待处理角标，处理后同步数量。首次连接不弹历史提醒，断线退避重连，隐藏标签页断开；不发送桌面权限请求或终端用户通知。连接不持有数据库事务，最长 295 秒并受令牌过期限制，20 秒保活、60 秒校准；跨实例使用已有 PostgreSQL LISTEN/NOTIFY。

供应商测试使用已保存模型版本、密钥和协议，可测停用中的供应商；单次固定短句、最多 30 秒、不自动重试，成功显示回复、耗时和 token，失败显示错误。每供应商 30 秒冷却并占用共享上游 RPM，不创建翻译任务、不扣用户额度；真实供应商可能收费。审计只保留结果、版本、耗时与用量，不保存密钥或回复全文。

### 私有入口配置

`ADMIN_WEB_PATH` 为空或未设置时关闭后台页面，API 和客户端登录仍可用。启用时设置单层路径，必须以 `/` 开头和结尾，中间为 2–80 位英文字母、数字、短横线或下划线；`admin`、`v1`、`internal`、`health`、`docs` 等保留名不可使用。建议生成随机入口后保存在对应私有环境文件，不写进仓库或公开页面：

```powershell
python -c "import secrets; print('ADMIN_WEB_PATH=/console-' + secrets.token_hex(16) + '/')"
```

本地 Compose 使用 `deploy/.env.local`；生产只使用服务器 Compose，应用配置位于部署目录 `.env.server`。开发引导脚本只在本地配置缺少该项时生成，重启不轮换；生产静态后台通过 OpenResty 独立发布，并沿用同一入口与 OIDC 回调，见[部署规范](DEPLOYMENT.md)。无尾斜线的新入口会补齐尾斜线并保留回调查询参数。

页面路由不进入 OpenAPI，`/v1/auth/config` 不返回入口。知道路径仍能加载登录页，管理员权限始终由服务端校验。更换入口后，旧入口不保留别名；已开始的后台登录需要重新发起。

生产后台用 `backend/Dockerfile.static` 的 `admin` 目标独立构建，不包含在 Python 镜像中。构建、发布和数据库兼容要求见[部署规范](DEPLOYMENT.md)。API、管理后台与工作进程必须遵守同一接口契约。

### 登录

生产沿用现有 OIDC 授权码 + PKCE。身份服务需要登记精确回调地址 `https://<服务域名><ADMIN_WEB_PATH>`（包含尾斜线），允许前端从该域名访问 token endpoint；配置沿用 `OIDC_CLIENT_ID / OIDC_AUTHORIZATION_ENDPOINT / OIDC_TOKEN_ENDPOINT / OIDC_AUDIENCE`。管理员角色以服务端的 `OIDC_ADMIN_ROLE` 为准。前端使用当前 origin + pathname 作为回调，授权与换令牌保持一致，并保留 state、PKCE、时效及回调路径检查。

配置或更换入口时，先在身份服务登记精确后台回调，保留插件及其他客户端回调；再同步 `ADMIN_WEB_PATH` 和 OpenResty。真实后台登录成功后才移除被替代的后台回调。仅更换路径时不修改 Client ID、Issuer、Audience、授权／令牌端点或 CORS 来源。

`DEV_AUTH=true` 时显示开发用户名登录，管理员用户名由 `DEV_ADMIN_USERNAME` 配置。公开服务必须关闭开发登录。访问令牌仅保存在当前浏览器标签页会话，退出后清除。服务端每个监控接口都校验管理员权限，普通账户返回 403；静态登录页可公开加载。

## 接口与数据边界

监控 GET 路由在 `/v1/admin/monitor` 下：

- `/overview`：全局快照、当前队列与近 24 小时统计。
- `/tasks`：默认 25 条、上限 100 条，支持 `q / mode / status / owner_id / node_id / offset / limit`。
- `/tasks/{id}`：任务执行详情。
- `/nodes`：节点和资源池运行信息。
- `/users`：用户分页，支持 `q / plan / offset / limit`。
- `/users/{id}`：用户权益与独立赠送摘要。

管理接口按业务归属注册：

| API 前缀 | 路径与用途 |
| --- | --- |
| `/v1/admin/translation-providers` | 列表、POST 创建、PUT 配置、PATCH 启停；`POST /{id}/test` 测试已保存连接，不回显密钥 |
| `/v1/admin/jobs/{id}` | `/attempts` 分页履历 |
| `/v1/admin/users/{id}` | `/membership / quota-grants / quota-compensations` 业务操作；`/quota-periods / usage-ledger / membership-operations / reserved-jobs` 历史分页 |
| `/v1/admin/quota-campaigns` | 额度活动页面使用；`PUT /{id}` 幂等创建、`PATCH /{id}` 按版本启用／暂停、`PATCH /{id}/duration` 调整期限、`GET /{id}/awards` 查看领取回执 |
| `/v1/admin/feedback` | 列表、`/{id}` 详情／处理、`/{id}/reviews` 历史分页 |
| `/v1/admin/billing` | `/orders` 与定向 reconcile；`/events` 及详情／retry；`/subscriptions` 及详情／invoices／terms；`/customers / accounts/{id}` |
| `/v1/admin/operations` | `/health / users/{id} / statistics` |
| `/v1/admin/workspace` | `/inbox` 反馈摘要，`/events` 管理员 SSE |
| `/v1/admin/support-requests` | 三类匿名反馈分页、`/{id}` 详情与 PATCH 处理 |
| `/v1/admin/audit` | 管理动作分页检索，仅显示脱敏元数据 |
| `/v1/admin/system-settings` | GET 当前版本与推荐提示词，PUT 完整配置（含两项提示词）及预期版本 |

监控与诊断 GET 只读取数据库元数据，不读取图片文件、不调用供应商、不改变队列或结算；状态“有效”不等于已探测对象存在。管理写操作和平台核实按各自业务产生副作用并记录审计。不向页面发送节点令牌、供应商密钥、图片、OCR 或译文全文；反馈评论和管理员处理备注属于有权限的业务记录。

用户准入将请求保护的活跃租约与漫画名查询限速分开展示。漫画名统计近 60 秒已受理次数、剩余次数及再次受理等待；已完成请求仍计入窗口，不能视为正在执行的请求。限速规则见[漫画名 API](COMIC_SEARCH_DESIGN.md)。

除支付管理模块使用 `page / page_size` 外，历史和诊断列表使用 `offset / limit`，每页上限 100。审计记录操作者、目标、前后值、原因与时间，同事务写入；回滚业务不留下成功审计。令牌、密钥、对象路径、签名地址、OCR／译文载荷不写入审计快照。

统计取最近 1–90 天并按 UTC 日期汇总。供应商／模型筛选仅作用于文本调用表；最多返回 2000 个分组并显式标记截断。文本金额含估算／未知消耗预占，不是已对账费用；复用数量统计本人 Job 完成后创建并指向该 Job 的请求 UUID，不是阅读浏览次数；订单原金额按币种分列，不作为净收入。服务健康只提供当前实例与积压，不提供历史告警。

## 匿名网站申请、插件与卸载反馈

插件漫画网站页和通用反馈窗无需登录，网站入口来自适配器注册元数据与随包图标。管理员分别查看网站申请、插件反馈和卸载反馈，不公开联系方式。

- `POST /v1/support-requests`：`kind=website|plugin|uninstall`，UUID `Idempotency-Key`；网站申请要求名称与公开 HTTP(S) 地址，插件与卸载反馈要求正文。名称／URL／说明／联系方式上限分别为 100／2048／1000／200 字符，联系方式可选且不限定邮箱。请求体最多 16 KiB。
- 网站地址拒绝凭据和本地地址，去除 query／fragment；服务端只保存，不抓取。重复原请求不新增记录，同编号改内容为 409。未知回包冻结原草稿与编号重试，已知拒绝允许修改。
- `GET /v1/admin/support-requests?kind=website|plugin|uninstall&offset=0&limit=25` 仅管理员可读，支持 `status` 筛选，按时间和 ID 倒序分页。`PATCH /{id}` 提交 `status / note / expected_reviewed_at`，状态为 received、reviewing 或 resolved，处理备注必填；过时更新返回 409，同状态与备注重放不重复记审计。三类共享匿名限流：对端地址摘要每 60 秒新增最多 5 条、UTC 日 20 条，重放不计；429 返回 `Retry-After`，转发地址只接受可信代理配置。
- `support_requests` 持久保存回执；限流与短期幂等计数保存在 Redis，到期自动回收。正文、联系方式、原网络地址不写默认日志；公开回执仅含 `id` 与 `created_at`。

卸载后通过浏览器 `runtime.setUninstallURL` 打开官网 `/uninstall/`，按插件界面语言选择简中、繁中、英文、日文或韩文页面，其他语言回退英文。地址不附带账号、安装标识或阅读记录。反馈自愿且无需登录，可跳过或直接关闭；选一个主要原因、选填最多 800 字说明，只有主动提交才创建记录。原因统一为中文文案与说明一起保存到 `comment`，`kind=uninstall`；不采集卸载统计，不发送 GA4 事件。页面不索引；当前标签页保存草稿和原始请求，未知回包时锁定内容，用同一个 UUID 重试，成功后显示已收到。上线需先部署后端、官网与管理后台，再发布含卸载入口的插件。

契约回归在 `backend/tests/test_support_requests.py`；隔离预览按后端运行文档准备 Python 依赖后，在 `backend` 执行 `python tests/support_preview.py --lose-first-response`，在插件目录以 `VITE_API_BASE=http://127.0.0.1:18089` 启动 Vite 5191。访问插件 `/#sites` 和后台 `/console-fixture/`（测试用户名 admin）；夹具创建临时库并模拟首次回包丢失，不访问外部服务。正式构建前清除 `VITE_API_BASE`。

## 验证

从 `backend/admin-ui` 执行 `npm run check`、`npm test`、`npm run build`。后端关键回归包含 `test_admin_workspace.py`、`test_admin_monitor.py`、`test_feedback_admin.py`和 `test_support_requests.py`，覆盖来源地址、管理员隔离、幂等与冲突、提交后提醒、供应商冷却和无用户扣费；支付和权益修改仍使用各自专用回归。

使用 `npm run demo` 在桌面浏览器验收：概览进入订单、用户内切换各页签、任务 IP 与国家、关闭多层详情后恢复位置、反馈处理与即时提醒、供应商测试成功/失败、表单校验。夹具打印的 `controls.json` 支持 `fail / delay` 模拟监控读取失败，`lose_receipt` 支持指定写接口在提交后返回一次 503；仅影响合成数据。截图与性能测量放在忽略的 `artifacts/`，不提交过程报告。

PostgreSQL 专项使用 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / TEST_PG_PORT / TEST_PG_USER / TEST_PG_PASSWORD`，运行 `test_admin_completion_postgres.py` 及既有支付／设置并发套件；测试固定限制在 `nodecomics_concurrency_test` 库，详见 `test_postgres_concurrency.py` 和 `deploy/compose.tests.yaml`。未启用的专用测试不计通过。

### 真实接入

真实文本供应商、OIDC、支付与文件卷按目标环境分别验收，模拟测试不能替代真实模型效果验证。

## 前端依赖

实际版本由 `backend/admin-ui/package-lock.json` 固定，下载完整性由其中 `integrity` 校验。运行时 React / React DOM **19.3.0**（MIT）；UI [Ant Design](https://github.com/ant-design/ant-design) **6.6.8** 与 [Ant Design Icons](https://github.com/ant-design/ant-design-icons) **6.3.4**（MIT）；构建 Vite **7.3.7**（MIT）、TypeScript **5.9.3**（Apache-2.0）。其余类型与构建插件以锁文件和包内许可为准。使用系统字体，无新增字体文件、模型权重、外部 CDN 或图片依赖。

后台国家解析使用 [maxminddb](https://github.com/maxmind/MaxMind-DB-Reader-python) **3.2.0**（Apache-2.0），版本、源包摘要和许可记录见 [backend/THIRD_PARTY.md](../backend/THIRD_PARTY.md)。
