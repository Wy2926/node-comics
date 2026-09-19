# 会员额度实现与验收

2026-09-15。会员权益与限时赠送已接入全新提交清单及集群调度；现行设计见[会员与翻译额度](MEMBERSHIP_AND_QUOTAS.md)和[集群队列](TRANSLATION_CLUSTER_DESIGN.md)，本轮测试、真实 R2、浏览器及部署边界统一见[集群验收](CLUSTER_VALIDATION.md)。下文旧验证数字只作为历史记录。

## 2026-09-16 翻译入口与运营赠送更新

- 翻译入口先恢复本人结果，再在权限或有限额度不足时以零额度、受限权益快照逐页申请平台免费复用。混合范围先恢复命中页，其余新增页继续按权益拒绝；主动重译仍需新任务权益。
- 确认界面说明单次提交全部受理或回滚、整份持续补充清单逐步受理。其他设备耗尽额度时保留前次受理结果，暂停剩余页。
- 独立后台用户权益详情可自定义赠送 PLUS 天数、新会员段每月重绘页数，或常规／重绘页数、生效与到期时间、备注；显示含预约生效的赠送记录。短期续期保留额度桶已用／预占值；未知响应保留原操作编号，可关闭详情后恢复。
- 客户端新增唯一 PLUS 套餐与绑卡试用：7 天试用、常规不限量、30 页重绘，之后 US$9.99 / 月自动续费，可取消。正式付费周期提供 300 页重绘；后端结账、业务回调和自动权益发放已实现，默认关闭。当前沙盒外部验收状态与配置见 [Paddle 套餐设计](PADDLE_BILLING_DESIGN.md)。

本次本地验证：后端相关 74 项、扩展 236 项、后台 5 项测试通过；扩展类型／模块检查、扩展与独立后台构建通过。Chrome 使用隔离 SQLite API 与模拟图片供应商完成 6 组交互检查并查看截图，覆盖跨用户免费复用、混合范围拒绝新增、阅读位置、赠送响应丢失恢复、预约生效、桌面与 390px 窄屏。未调用真实图片模型或 Paddle；未执行本轮 PostgreSQL 并发检查，未部署到公开服务。

历史赠送流程复现说明（当前参数与脚本范围见[阅读契约验收](READING_TRANSLATION_CONTRACT.md#10-实现与验证记录)）：先在 `backend/admin-ui` 执行 `npm run build`；在 `backend` 分别运行 `.venv/Scripts/python.exe tests/manual_admin_server.py`（18090）与 `.venv/Scripts/python.exe tests/manual_ui_server.py`（18089）。在 `apps/extension` 运行 `npm exec vite -- --host 127.0.0.1 --port 5174 --strictPort`。根目录设置 `UI_FIXTURE_DIRECTORY` 为 reader fixture 输出的临时目录，必要时用 `PLAYWRIGHT_MODULE` 指向已安装的 Playwright，再运行 `node scripts/verify_membership_admin.mjs`。结果和截图保存到本地忽略目录 `artifacts/membership-updates/`。管理员赠送和查询无需真实存储／支付配置；测试入口禁用产品环境文件。

## 已实现

| 身份 | 常规翻译 | AI 重绘 | 每模式在途容量 | 每模式实时名额 | 同级权重 |
| --- | --- | --- | --- | --- | --- |
| 普通用户 | 每日 100 页 | 基础权益不包含；有效赠送可临时使用 | 10 页 | 2 页 | 1 |
| PLUS | 不限累计页数 | 每会员月 300 页，不累积；年付逐月发放 | 500 页 | 10 页 | 2 |

两种模式独立排队；实时优先、预存保留最低服务份额，同级按可配置用户权重公平分配，资源空闲时可借用更多执行位。容量与实时名额都不代表每用户固定执行并发。

额度按成功新版本计页，预占、结算、失败释放幂等。任务绑定实际额度记录，跨日、跨会员月、跨赠送到期均不转扣下一笔。缓存和进行中任务复用不重复计量。PLUS 常规保留实际交付统计，供应商成本继续单独记录。

任意期限赠送已具备数据库、逻辑、管理员 API 与独立后台界面：支持常规／重绘、预约生效、独立到期、最早到期优先消耗、幂等发放、审计及私有查询。重绘赠送提供临时权限，不提高队列容量、实时名额或套餐权重。活动管理、兑换码尚未接入。

单页、整章、所选页段与重译明确确认本次页数上限后保存上传清单。可选择有空位时持续补充本次范围；客户端读取有效额度、模式容量并优先上传当前阅读页，权益变化时显示原因并按新权益重新确认。已有任务或结果直接复用；未知提交保留同一请求和操作编号核实，不重新生成收费任务。原图与译图默认无限期保留，不随日／月额度到期删除。

详细规则与接口参数见[会员与翻译额度](MEMBERSHIP_AND_QUOTAS.md)，机器契约见 [OpenAPI](../contracts/openapi.json)。

## 新数据库与配置

迁移基线为 `shared_0001`。旧钱包、报价、固定用户执行名额、旧提交结构及队列消息兼容层已删除。禁止把旧库直接 stamp 到新版本；使用新数据库，并配套启动 API、控制 worker、维护服务、计算节点和客户端。

部署步骤与独立 Compose 项目名称统一见[后端运行说明](../backend/README.md)。现有数据卷不会因修改 PostgreSQL 初始化变量自动创建新库；须使用新数据库，并将对象存储前缀一并隔离，避免不同版本混用。以上为部署要求，不代表已执行产品服务切换。

配置默认值：

```dotenv
FREE_DAILY_PAGES=100
PLUS_MONTHLY_REDRAW_PAGES=300
QUOTA_TIMEZONE=Asia/Shanghai
FREE_QUEUE_CAPACITY=10
PLUS_QUEUE_CAPACITY=500
FREE_REALTIME_SLOTS=2
PLUS_REALTIME_SLOTS=10
FREE_SCHEDULER_WEIGHT=1
PLUS_SCHEDULER_WEIGHT=2
RETENTION_DAYS=0
```

已建立的额度记录保留发放时的总量；连续会员段保留月额度快照。额外补偿走显式管理操作。

开发登录 `admin` 可管理会员；管理员角色本身仍是普通权益。真实供应商验收脚本 `scripts/smoke_api.py` 使用新的独立记录文件；`--grant-plus` 显式为该测试账号开通一个会员月，只有 `--translate` 才请求翻译。本轮没有运行真实供应商验收或调用付费图片模型。

## 集群重构前的历史验证

- 后端：210 项通过；默认跳过 24 项需要额外环境的检查。其中 PostgreSQL 的 16 项已在专用数据库另行运行并全部通过，其余 8 项外部环境检查未运行。
- PostgreSQL：独立 `nodecomics_concurrency_test` 数据库，每个案例使用随机 schema 并清理；覆盖新库并发初始化、重复创建／投递／结算、共享任务、队列上限、最后日额度与赠送额度竞争、重复发放及跨用户误用操作编号。
- 时间规则：日边界、会员月、1 月 31 日的月末锚点、年付逐月额度、会员到期、预约赠送生效、赠送到期后原任务结算和失败释放。
- 前端：24 个测试文件、233 项测试通过，TypeScript 与 84 个模块依赖检查通过；Chrome MV3 与 Web 构建通过。
- Chrome：真实本地 API、数据库、调度及 worker，供应商返回合成图。普通／PLUS／赠送账户、只读执行并发、单页直接翻译、重绘确认、自动缩量与耗尽、新赠送恢复、页码保持、实际交付统计、管理员续期及重复提交通过；检查 1440 与 700 像素页面截图。

历史浏览器运行曾输出 `artifacts/membership-validation/results.json` 及账户、额度耗尽、重绘确认、用量和管理员截图；该忽略目录不随仓库提供，当前工作区未保留这份历史结果。旧场景曾预置测试账号当日已用 98 页，不属于本轮集群验收。现有同名脚本已迁移到提交清单和独立模式队列，运行后会生成本次结果。

另一套自动翻译恢复检查（历史本地产物 `artifacts/auto-validation/results.json`）覆盖临时网络失败、已知额度拒绝、未知提交原编号核实、权益变化暂停、跨书恢复、关闭选择记忆和连续滚动位置。两套脚本共 22 项检查通过，无浏览器异常；它们不覆盖网页采集或扩展弹出页。

## 当前可重复命令

仓库根目录：

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
backend/.venv/Scripts/python.exe scripts/export_openapi.py
```

PostgreSQL 检查只使用专用测试环境，禁止使用产品数据库。当前隔离数据库、项目及可重复命令统一见[集群验收](CLUSTER_VALIDATION.md)，服务启动见[后端运行说明](../backend/README.md)；测试的隔离校验见 [PostgreSQL 测试](../backend/tests/test_postgres_concurrency.py)。

浏览器夹具与 Vite 分别启动：

```powershell
backend/.venv/Scripts/python.exe backend/tests/manual_ui_server.py
# 另一个终端，在 apps/extension：
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort
```

当前浏览器验收改用 `scripts/verify_reading_api.mjs`（真实 API／worker 与合成供应商）、`scripts/verify_reading_plans.mjs`（窗口、限流及丢回包恢复）与 `scripts/verify_membership_admin.mjs`（赠送和分钟配置）。旧 10/500、2/10、3/10 队列契约及对应脚本已删除；运行端口和环境要求见[阅读契约验收](READING_TRANSLATION_CONTRACT.md#10-实现与验证记录)。

在 `apps/extension` 执行 `npm run check`、`npm test`、`npm run build`、`npm run build:web`。本次浏览器检查使用 Chrome；Edge 未单独运行。没有以模拟图片声称验证 OCR、重绘效果或真实供应商兼容性。
