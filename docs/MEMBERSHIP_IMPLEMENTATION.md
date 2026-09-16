# 会员额度实现与验收

2026-09-15。会员权益与限时赠送已接入全新提交清单及集群调度；现行设计见[会员与翻译额度](MEMBERSHIP_AND_QUOTAS.md)和[集群队列](TRANSLATION_CLUSTER_DESIGN.md)，本轮测试、真实 R2、浏览器及部署边界统一见[集群验收](CLUSTER_VALIDATION.md)。下文旧验证数字只作为历史记录。

## 已实现

| 身份 | 常规翻译 | AI 重绘 | 每模式在途容量 | 每模式实时名额 | 同级权重 |
| --- | --- | --- | --- | --- | --- |
| 普通用户 | 每日 100 页 | 基础权益不包含；有效赠送可临时使用 | 10 页 | 2 页 | 1 |
| PLUS | 不限累计页数 | 每会员月 300 页，不累积；年付逐月发放 | 500 页 | 10 页 | 2 |

两种模式独立排队；实时优先、预存保留最低服务份额，同级按可配置用户权重公平分配，资源空闲时可借用更多执行位。容量与实时名额都不代表每用户固定执行并发。

额度按成功新版本计页，预占、结算、失败释放幂等。任务绑定实际额度记录，跨日、跨会员月、跨赠送到期均不转扣下一笔。缓存和进行中任务复用不重复计量。PLUS 常规保留实际交付统计，供应商成本继续单独记录。

任意期限赠送已具备数据库、逻辑和管理员 API：支持常规／重绘、预约生效、独立到期、最早到期优先消耗、幂等发放、审计及私有查询。重绘赠送提供临时权限，不提高队列容量、实时名额或套餐权重。活动管理、兑换码、赠送管理前端和支付订阅尚未接入。

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

另一套[自动翻译恢复检查](../artifacts/auto-validation/results.json)覆盖临时网络失败、已知额度拒绝、未知提交原编号核实、权益变化暂停、跨书恢复、关闭选择记忆和连续滚动位置。两套脚本共 22 项检查通过，无浏览器异常；它们不覆盖网页采集或扩展弹出页。

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

在仓库根目录设置 `UI_FIXTURE_DIRECTORY` 为夹具打印的临时目录；`PLAYWRIGHT_MODULE` 指向已经安装的 Playwright 包，默认使用已安装的 Chrome。执行 `node scripts/verify_membership.mjs`，验证赠送额度、单页明确确认、每模式 10/500 容量与 2/10 实时名额、会员续期幂等。集群预存与关闭页面后的阅读恢复使用 `node scripts/verify_cluster_reader.mjs`。两者都只连接夹具的 `127.0.0.1:18089`，常规模式执行由集群测试覆盖。

在 `apps/extension` 执行 `npm run check`、`npm test`、`npm run build`、`npm run build:web`。本次浏览器检查使用 Chrome；Edge 未单独运行。没有以模拟图片声称验证 OCR、重绘效果或真实供应商兼容性。
