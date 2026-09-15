# 会员额度实现与验收

2026-09-15。代码已实现，本地隔离验证完成；现有产品服务尚未切换，未公开部署。

## 已实现

| 身份 | 常规翻译 | AI 重绘 | 执行并发 |
| --- | --- | --- | --- |
| 普通用户 | 每日 100 页 | 基础权益不包含；有效赠送可临时使用 | 2 |
| PLUS | 不限累计页数 | 每会员月 300 页，不累积；年付逐月发放 | 2 |

额度按成功新版本计页，预占、结算、失败释放幂等。任务绑定实际额度记录，跨日、跨会员月、跨赠送到期均不转扣下一笔。缓存和进行中任务复用不重复计量。PLUS 常规保留实际交付统计，供应商成本继续单独记录。

任意期限赠送已具备数据库、逻辑和管理员 API：支持常规／重绘、预约生效、独立到期、最早到期优先消耗、幂等发放、审计及私有查询。重绘赠送提供临时权限，不提高执行并发。活动管理、兑换码、赠送管理前端和支付订阅尚未接入。

常规单页直接开始；AI 单页、批量与重译确认页数上限。自动翻译按有效额度与待处理队列缩小范围，耗尽暂停；有效赠送到账后，读取新权益即可在原同意范围内继续。未知提交保留同一操作编号，核实前停止新增。

详细规则与接口参数见[会员与翻译额度](MEMBERSHIP_AND_QUOTAS.md)，机器契约见 [OpenAPI](../contracts/openapi.json)。

## 新数据库与配置

迁移基线为 `membership_0001`，包含 20 张表。旧钱包、报价、用户自设服务器并发模型及旧迁移链已删除。禁止把旧库直接 stamp 到新版本；使用一个新数据库，再配套启动当前 API、dispatcher、worker 和客户端。

首次安装仍可按 [README](../README.md) 启动。已有 Compose 数据卷时，PostgreSQL 容器的初始化环境变量不会自动创建新数据库，可按以下方式准备新库：

```powershell
# 在确认目标为本项目 PostgreSQL 容器后创建一个新库；保留旧库。
docker exec node-comics-postgres-1 createdb -U nodecomics nodecomics_membership
```

然后在 `deploy/.env.local` 设置 `POSTGRES_DB=nodecomics_membership`，按正常启动流程统一更新本项目服务。外部 PostgreSQL 直接使用新的 `DATABASE_URL`。对应本地存储、对象存储前缀和队列也应与数据库一起管理，避免不同版本混用。此次实现仅在独立测试库／临时目录运行，没有执行上述产品服务切换。

配置默认值：

```dotenv
FREE_DAILY_PAGES=100
PLUS_MONTHLY_REDRAW_PAGES=300
QUOTA_TIMEZONE=Asia/Shanghai
FREE_CONCURRENCY=2
PLUS_CONCURRENCY=2
```

已建立的额度记录保留发放时的总量；连续会员段保留月额度快照。额外补偿走显式管理操作。

开发登录 `admin` 可管理会员；管理员角色本身仍是普通权益。真实供应商验收脚本 `scripts/smoke_api.py` 使用新的独立记录文件；`--grant-plus` 显式为该测试账号开通一个会员月，只有 `--translate` 才请求翻译。本轮没有运行真实供应商验收或调用付费图片模型。

## 验证

- 后端：210 项通过；默认跳过 24 项需要额外环境的检查。其中 PostgreSQL 的 16 项已在专用数据库另行运行并全部通过，其余 8 项外部环境检查未运行。
- PostgreSQL：独立 `nodecomics_concurrency_test` 数据库，每个案例使用随机 schema 并清理；覆盖新库并发初始化、重复创建／投递／结算、共享任务、队列上限、最后日额度与赠送额度竞争、重复发放及跨用户误用操作编号。
- 时间规则：日边界、会员月、1 月 31 日的月末锚点、年付逐月额度、会员到期、预约赠送生效、赠送到期后原任务结算和失败释放。
- 前端：24 个测试文件、233 项测试通过，TypeScript 与 84 个模块依赖检查通过；Chrome MV3 与 Web 构建通过。
- Chrome：真实本地 API、数据库、调度及 worker，供应商返回合成图。普通／PLUS／赠送账户、只读执行并发、单页直接翻译、重绘确认、自动缩量与耗尽、新赠送恢复、页码保持、实际交付统计、管理员续期及重复提交通过；检查 1440 与 700 像素页面截图。

浏览器证据位于 [artifacts/membership-validation](../artifacts/membership-validation/results.json)，包含结果 JSON 与账户、额度耗尽、重绘确认、用量和管理员截图。该目录为忽略的本地测试产物，不含真实漫画或供应商凭据。为验证额度耗尽，夹具预置测试账号当日已用 98 页；本次实际合成任务与该预置明确分开。

另一套[自动翻译恢复检查](../artifacts/auto-validation/results.json)覆盖临时网络失败、已知额度拒绝、未知提交原编号核实、权益变化暂停、跨书恢复、关闭选择记忆和连续滚动位置。两套脚本共 22 项检查通过，无浏览器异常；它们不覆盖网页采集或扩展弹出页。

### 可重复命令

仓库根目录：

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
backend/.venv/Scripts/python.exe scripts/export_openapi.py
```

PostgreSQL 只使用专用测试库，首次需要创建 `nodecomics_concurrency_test`；完整环境约束见 [PostgreSQL 测试](../backend/tests/test_postgres_concurrency.py)。

```powershell
docker run --rm --network node-comics_default --env-file deploy/.env.local `
  -e RUN_POSTGRES_CONCURRENCY=1 -e TEST_PG_HOST=postgres `
  -e RESULT_STORAGE_BACKEND=local -e R2_ENDPOINT_URL= `
  --mount type=bind,source=D:/Project/nodelane/node-comics/backend,target=/app,readonly `
  node-comics-backend:local python -m pytest tests/test_postgres_concurrency.py `
  tests/test_shared_jobs_postgres.py tests/test_queue_postgres.py tests/test_membership_postgres.py `
  -q -p no:cacheprovider
```

将挂载路径改为当前 checkout 的绝对路径。测试禁止使用产品数据库。

浏览器夹具与 Vite 分别启动：

```powershell
backend/.venv/Scripts/python.exe backend/tests/manual_ui_server.py
# 另一个终端，在 apps/extension：
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort
```

在仓库根目录设置 `UI_FIXTURE_DIRECTORY` 为夹具打印的临时目录；`PLAYWRIGHT_MODULE` 指向已经安装的 Playwright 包，默认使用已安装的 Chrome。执行 `node scripts/verify_membership.mjs`；自动翻译网络失败、未知提交和权益变化的恢复检查可使用 `node scripts/verify_auto_translation.mjs`。两者都只连接夹具的 `127.0.0.1:18089`。

在 `apps/extension` 执行 `npm run check`、`npm test`、`npm run build`、`npm run build:web`。本次浏览器检查使用 Chrome；Edge 未单独运行。没有以模拟图片声称验证 OCR、重绘效果或真实供应商兼容性。
