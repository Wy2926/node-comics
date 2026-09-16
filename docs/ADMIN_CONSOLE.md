# 服务端管理后台

2026-09-16：已实现独立 React + TypeScript + Vite 管理页面，服务端入口 `/admin/`。针对当前集群数据模型实现，不增加旧队列、旧点数或旧数据适配逻辑。

## 页面与统计口径

| 页面 | 信息与操作 |
| --- | --- |
| 运行概览 | 当前在途、排队等待、有效执行租约、近 24 小时完成和失败；常规／重绘分别按上传、排队、运行、待核实统计；实时／预存、暂停队列、阶段积压、用户和资源概况 |
| 翻译任务 | 按任务 ID／用户名搜索，按模式、状态、当前优先级、用户和参与节点筛选；分页查看；详情包含起止时间、各阶段、每次执行代次、节点、执行机／进程及文本调用计量 |
| 计算节点 | 图像计算节点与控制资源池、设备、引擎版本、能力、启停状态、心跳、执行位占用、过期租约，以及近 24 小时阶段次数／耗时；跳转参与任务 |
| 用户管理 | 普通／PLUS 筛选、角色、注册时间、最近提交时间、累计任务与完成／失败量、当前在途；详情查看会员到期、两种模式额度及有效额度明细 |

- **在途页数**：`awaiting_upload / validating_upload / queued / running / outcome_unknown`。用户队列暂停仍计入在途。
- **排队等待**：任务状态为 `queued`；“最早提交已等待”从这些任务最早的创建时间计算。已开始任务的阶段间等待需结合阶段积压与任务详情查看。
- **阶段积压**：按 `JobStage` 状态统计。一个任务可能有多个阶段，待执行包含暂停、退避和暂时不满足资源条件的阶段，不等于可立即领取的页数。
- **总耗时**：任务创建至结束，未结束则至当前时间。
- **首次等待**：任务创建至首次租约领取，尚未领取则至结束／当前时间。包含首次上传等待。
- **执行占用**：租约时间区间的并集，文本翻译与背景修复并行时不重复累计；已过期租约截止到过期时间。它包含阶段内部的网络、存储与处理，不等于模型纯推理耗时。
- **非执行时间**：总耗时减执行占用，包含上传、排队、阶段间等待和恢复间隔。
- **交付节点**：成功交付对应的 render／redraw 阶段；无文字任务取 analyze／redraw 阶段。所有参与节点和重试都保留在执行履历。缓存命中没有新增执行，执行占用为零。
- **控制资源池**：`control-text / control-redraw / control-validate_upload` 是共享执行容量。控制工作进程领取时写入 `executor_id=hostname:pid`，任务详情可定位执行机／进程。图像节点直接记录其注册 ID。
- **过期租约**：单独标记为待回收，不显示成有效执行；回收前仍占资源容量。
- **最近提交**表示最近任务创建时间；系统未记录用户最后登录或当前在线状态，后台不会据此推断。
- 时间按浏览器本地时区显示。列表默认每 15 秒刷新，可暂停；后台标签页隐藏或详情打开时停止列表定时刷新。请求失败保留上次数据并标记可能过时，支持重试。

后台本次提供运行信息查询；会员变更、供应商编辑和结果核实仍使用现有运营接口／插件入口。

## 运行与构建

前端源码：`backend/admin-ui/`。本机需要 Node.js 22+、npm，后端环境要求见 [backend/README.md](../backend/README.md)。

```powershell
cd backend/admin-ui
npm ci
npm run check
npm run build
```

构建输出到 `backend/app/admin_web/dist/`，已被仓库忽略。API 进程托管 HTML 和打包资源；同源访问，无需额外管理站点或运行 Node.js 服务。开发预览可运行 `npm run dev`，访问 `http://127.0.0.1:5175/admin/`，默认代理 API `http://127.0.0.1:18088`，可用 `ADMIN_API_ORIGIN` 指定本地测试服务。

容器构建 `docker build -t node-comics-backend:local backend` 自动完成前端构建并复制到最终 Python 镜像。API 使用全新空库基线 `shared_0001`，已包含执行机字段、任务索引与节点身份配置；不升级旧数据库。控制工作进程需使用同版本代码以记录执行机。

### 登录

生产沿用现有 OIDC 授权码 + PKCE。身份服务需要登记公开客户端回调地址 `https://<服务域名>/admin/`，允许前端从该域名访问 token endpoint；配置沿用 `OIDC_CLIENT_ID / OIDC_AUTHORIZATION_ENDPOINT / OIDC_TOKEN_ENDPOINT / OIDC_AUDIENCE`。管理员角色以服务端的 `OIDC_ADMIN_ROLE` 为准。

`DEV_AUTH=true` 时显示开发用户名登录，管理员用户名由 `DEV_ADMIN_USERNAME` 配置。公开服务必须关闭开发登录。访问令牌仅保存在当前浏览器标签页会话，退出后清除。服务端每个监控接口都校验管理员权限，普通账户返回 403；静态登录页可公开加载。

## 接口与数据边界

新增的 GET 路由均在 `/v1/admin/monitor` 下：

- `/overview`：全局快照、当前队列与近 24 小时统计。
- `/tasks`：默认 25 条、上限 100 条，支持 `q / mode / status / priority / owner_id / node_id / offset / limit`。
- `/tasks/{id}`：任务执行详情。
- `/nodes`：节点和资源池运行信息。
- `/users`：用户分页，支持 `q / plan / offset / limit`。
- `/users/{id}`：用户权益和模式队列状态。

查询只读取数据库元数据，不访问 R2，不调用模型，不改变队列、额度或结算。不向页面发送节点令牌、供应商密钥、图片、OCR 结果或译文全文。文本调用展示已记录的成本状态和预占，未知成本不记为零。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests -q
# 只检查后台：
.venv/Scripts/python.exe -m pytest tests/test_admin_monitor.py tests/test_cluster_schema.py -q
# 独立浏览器验收服务，使用一次性 SQLite、合成元数据，不读取生产环境文件：
.venv/Scripts/python.exe tests/manual_admin_server.py
```

验收地址 `http://127.0.0.1:18090/admin/`，开发用户名 `admin`。夹具会输出临时 `controls.json` 路径，将其中 `delay` 设置为 0–10 秒、`fail` 设置为 true/false，可复现加载、失败与恢复。夹具中节点心跳固定，会按真实超时规则自然离线。

PostgreSQL 检查使用现有隔离 `pg_scope`，设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_HOST / TEST_PG_PORT / TEST_PG_USER / TEST_PG_PASSWORD` 后运行 `tests/test_admin_monitor_postgres.py`。它只使用 `nodecomics_concurrency_test` 内随机 schema，覆盖 PostgreSQL 统计表达式和最终迁移结构。

本轮证据：后端全套 **297 passed / 30 skipped**（当次尚未加入独立 PostgreSQL 后台测试）；随后在独立 PostgreSQL 17.6 容器中通过后台查询／迁移检查与 **14 项集群调度并发检查**。React 类型检查和生产构建通过，Docker 多阶段构建通过。浏览器完成管理员／普通用户访问、四个页面、分页、筛选、任务跨节点履历、权益详情、390px 窄屏、刷新暂停、慢请求、服务失败与重试恢复检查。

这是代码、本地运行和隔离数据验证；未验证生产 OIDC、生产负载或真实线上运行数据，未部署公开服务。

## 前端依赖

实际版本由 `backend/admin-ui/package-lock.json` 固定，下载完整性由其中 `integrity` 校验。运行时 React / React DOM **19.3.0**（MIT）；构建 Vite **7.3.6**（MIT）、TypeScript **5.9.3**（Apache-2.0）。其余类型与构建插件以锁文件和包内许可为准。使用系统字体，无新增字体文件、模型权重、外部 CDN 或图片依赖。

计算节点页已支持后台预建、独立凭据、配置编辑、停用和轮换，见[节点配置](NODE_CONFIGURATION.md)。

2026-09-16 更新：配置支持表单／JSON 双向切换、全部 16 种目标语言多选；图像节点以及 AI 重绘／文本翻译／上传校验三个控制资源池均有配置入口。控制池容量持久化，API 启动初始化缺失资源池，工作进程重启不覆盖管理设置。文本金额使用人民币单位，只统计每次调用及未知成本预占，不限制成本；重试次数、时限、RPM 保留。任务详情显示具体失败原因与错误码。新实现面向新数据库，不增加旧数据转换分支。

隔离浏览器服务端口可通过 `ADMIN_FIXTURE_PORT` 覆盖；`controls.json` 的延迟／失败注入同时覆盖节点配置读取和保存。
