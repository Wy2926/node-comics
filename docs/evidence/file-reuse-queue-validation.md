# 文件页复用与用户公平队列验证

日期：2026-09-14。范围：文件 SHA-256＋原始页索引、跨设备恢复、前端并发、后端用户公平调度与重复提交计费保护。

## 隔离边界

后端契约测试使用 pytest 临时目录和 SQLite；PostgreSQL 竞争测试只连接 `nodecomics_concurrency_test`，每例创建独立随机 schema。供应商由测试函数替换，不使用真实模型服务。

Chrome 验收使用 `127.0.0.1:5173` 和 `localhost:5173` 两个独立本地存储来源，连接单独的 `127.0.0.1:18090` SQLite 测试 API。测试账户中预置常规／重绘各一个已完成任务，输出直接复用公开原创示例原图，只验证匹配、授权下载、界面和计费行为，不代表翻译质量。服务端始终只有这两个任务、四笔预占／结算账本和一个文件页映射，验收没有发起供应商请求。验收后清理了本次创建的浏览器示例，恢复默认服务地址并停止测试进程；产品容器未重启。

## 前端

在 `apps/extension` 执行：

```powershell
npm test
npm run check
npm run build
npm run build:web
```

9 个测试文件、77 项测试通过，类型检查、Chrome MV3 构建及 Web 构建通过。覆盖 SHA-256 标准向量／分块边界、MOBI 固定页序、图片文件身份、100 页查询拆批、账户隔离、并发上限和动态调整、失败页独立继续、迟到恢复响应、资产别名／重复本地页关联、重新生成报价绑定、任务丢失本地页面后的持久记录及跨配置版本排序。

## 后端与数据库竞争

在仓库根目录执行：

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q --disable-warnings --tb=short
```

最终结果：140 passed、14 skipped、2 warnings，32.43 秒。14 项跳过均为需要独立入口的 PostgreSQL 专项，不计为通过。测试覆盖文件标识校验与同账户匹配、版本／配置隔离、过期／删除／缺失文件、幂等收据、共享任务与实际计费、免费 no_text 缓存，以及供应商／价格变化后的未知重绘保护。公平调度覆盖多批次和跨模式共用名额、超出扫描窗口的积压、轮转持久化、发布失败重投、重复／失效 token、取消恢复、降低并发与权限。

实际 PostgreSQL 验证另行执行，使用现有 Docker 网络、测试镜像内的运行环境和只读挂载的当前源码：

```powershell
docker run --rm --network node-comics_default --env-file deploy/.env.local -e RUN_POSTGRES_CONCURRENCY=1 -e TEST_PG_HOST=postgres --mount type=bind,source=D:/Project/nodelane/node-comics/backend,target=/app,readonly node-comics-backend:local python -m pytest tests/test_shared_jobs_postgres.py tests/test_postgres_concurrency.py tests/test_queue_postgres.py tests/test_file_pages_postgres.py -q -p no:cacheprovider --tb=short
```

结果：14 passed，9.27 秒。覆盖两个设备均先匹配未命中后独立确认，只产生一个执行任务、一次预占及一次结算；单页与批次同时提交；共享任务外键与 worker 结算的受控锁竞争；多 dispatcher、公平名额、重复 worker、多个消息发布者、限额下调；文件页映射并发上传；原有创建、取消、删除和恢复竞争。各例执行迁移至 `0006`，只使用测试库中的随机 schema，结束后移除该 schema。

当前源码的 OpenAPI 已离线重新导出，共 31 条路径；导出未连接运行中的服务。`git diff --check` 通过。

## Chrome 操作与截图检查

- 空白本地设置显示请求并发 2，改成 10 后刷新仍为 10，输入 11 被限制为 10。
- 账户队列并发保存为 3 后刷新仍为 3；第二个存储来源保持本机默认 2，但同账户服务器并发读取为 3。
- 两个空白书架分别打开相同原创样本，都通过文件标识找回常规 v1，成功显示授权下载的测试输出；原图／结果对照截图已检查。
- 再次点击普通翻译提示已有结果，不出现新任务报价，账户仍为 991 点。
- 手动恢复前后，页面 ID 相同，阅读区域 `scrollTop` 均为 `23.703704833984375`。
- 停止隔离 API 后，“恢复已有翻译”显示匹配失败和可重试提示，本地原图仍可读；重启隔离 API 后同按钮恢复成功。

测试没有安装新版扩展到商店或执行真实站点采集；浏览器验证针对同一套前端源码的本地 Web 阅读器。译图与原图仍受服务器保留期约束，默认 7 天，书架和位置不进行云同步。
