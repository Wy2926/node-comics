# 提交入场与调度

本页描述当前实现；使用新建数据库，不迁移旧调度或旧数据。

## 提交反滥用

`POST /v1/translation-submissions` 在进入调度锁前，使用独立事务更新用户的 `submission_admissions` 行。所有 API 副本共享数据库中的请求桶、页面桶、当天提交次数／描述符数和短期执行租约；增加副本、不同设备和更换幂等键不会获得新预算。PostgreSQL 只锁当前用户的入场行，SQLite 用写事务串行化测试。

| 环境变量 | 默认 | 规则 |
| --- | ---: | --- |
| `SUBMISSION_MAX_BODY_BYTES` | 524288 | 在 ASGI 接收阶段限制 JSON 字节，包含分块请求 |
| `SUBMISSION_REQUESTS_PER_MINUTE` | 60 | 请求令牌每分钟恢复数量 |
| `SUBMISSION_REQUEST_BURST` | 30 | 请求令牌桶容量 |
| `SUBMISSION_ITEMS_PER_MINUTE` | 2000 | 页面描述符令牌每分钟恢复数量 |
| `SUBMISSION_ITEM_BURST` | 1000 | 页面令牌桶容量，至少容纳一次 500 页提交 |
| `SUBMISSION_CONCURRENCY` | 4 | 单用户同时处理的提交数 |
| `SUBMISSION_LARGE_BATCH_ITEMS` | 100 | 达到该页数视为大批次 |
| `SUBMISSION_LARGE_BATCH_CONCURRENCY` | 1 | 单用户大批次同时处理数 |
| `SUBMISSION_ADMISSION_LEASE_SECONDS` | 300 | 进程退出后的入场租约回收期限 |
| `SUBMISSION_RECEIPTS_PER_DAY` | 2000 | 单用户每天新幂等键的入场次数，UTC 零点恢复 |
| `SUBMISSION_ITEMS_PER_DAY` | 20000 | 单用户每天新幂等键的页面描述符总数，防止一个任务产生大量重复清单项 |
| `SUBMISSION_RECEIPT_RETENTION_DAYS` | 30 | 完整回执至少保留的天数 |

以上预算独立于普通／PLUS 的任务在途容量。重复利用同一任务、新建清单、幂等回放均消耗请求及页令牌；已存在回执的幂等回放不消耗当天新增预算。入场后发生校验失败或任务事务回滚仍消耗预算，避免用失败请求无限占用调度锁。正常结束或失败会释放并发租约；崩溃留下的租约到期回收。服务请求处理时间应小于租约期限；接入层应设置相应超时。

已验证原图的新提交只绑定当前清单的文件页，不随同一任务历史清单增长而反复读取全部描述符。上传首次完成时仍绑定等待该上传的各份清单，保留跨文件及设备的页面映射。

超限返回 `429`，错误代码为 `SUBMISSION_RATE_LIMITED`、`SUBMISSION_BUSY` 或 `SUBMISSION_DAILY_LIMIT`，同时提供 `Retry-After` 和 `error.retry_after_seconds`。客户端保留原幂等键，在等待后重试。大批次达到并发上限时，小批次仍可在剩余执行名额内提交。建议先保持默认值，根据实际接收延迟与数据库负载调整，不通过增加免费或 PLUS 队列容量解决提交洪泛。

## 完整回执与幂等保留

维护循环每轮最多归档 100 个回执。只有回执创建时间及全部关联任务的完成时间均超过保留期，且所有任务都已结束，才删除 `submission_items` 中的详细描述及该用户、该清单的内部 `JobRequest` 逐页回执。仍在上传、排队、执行或上游结果未知的清单不会归档。没有完成时间的异常记录也保留待处理。

`translation_submissions` 保留用户、幂等键、请求摘要等少量元数据，并记录 `archived_at`。归档后的键重复提交返回 `410 SUBMISSION_ARCHIVED`，内容不一致仍返回 `409 IDEMPOTENCY_CONFLICT`；不会再次创建任务或扣页。任务、结算、原图、译图不随回执归档删除。列表只显示完整回执；历史任务和结果仍从任务记录查询。轻量幂等记录继续增长，其新增速度受每日预算限制，不设置会永久封住正常账户的终生提交上限。

## 数据库候选选举

数据库先排除暂停队列、无效原图、未到执行时间、配置或语言不符、供应商执行位已满等候选，再按资源池、实时／预存类别和用户选出该用户最优页面，按公平服务时间选每个资源池与类别的前两名用户。仅把这些候选载入 Python，不按创建时间截断队头，因此大批量旧任务不能遮挡后到的低服务量用户。

全队列 SQL 窗口选举复用调用方 Session 和连接，常规只读领取在获取调度锁之前完成，只传递有界的 stage ID、执行代次和优先级／队列版本，不额外借连接或提交调用方事务。若调用方已有待写对象，先在禁止自动 flush 的作用域取得调度锁，保持 scheduler → user/job 写锁顺序。锁内以最新数据复核这些候选的阶段状态、队列、原图、节点、供应商容量和公平状态，然后分配租约。优先级或队列版本变化、阶段已被其他节点领取等竞争会放弃失效候选；本轮没有可用候选时，下轮重新选举，不沿用旧快照强行执行。

锁内原图检查只针对候选，本地存储检查文件存在性，R2 不发送 HEAD。本地原图已丢失的候选通过失败结算释放额度，下一轮可选后续页面，避免缺失队头长期遮挡。图像准备积压与文本速率计数只读取达到阈值所需的行。第二名用户用于更新虚拟服务时间下界。实时／预存份额、普通／PLUS 权重、空闲执行位借用、30 分钟老任务优先和阅读位置排序沿用既定规则。锁外选举仍有随数据库规模增长的成本，应结合节点数和领取频率监控数据库 CPU。

## 验证

使用项目虚拟环境运行：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_submission_limits.py tests/test_cluster_submissions.py tests/test_cluster_scheduler.py -q
```

PostgreSQL 用既有隔离测试入口与专用 `nodecomics_concurrency_test` 数据库，设置 `RUN_POSTGRES_CONCURRENCY=1` 及 `TEST_PG_*` 后运行 `tests/test_submission_limits_postgres.py` 与 `tests/test_cluster_scheduler_postgres.py`。测试验证跨连接请求／页预算、并发与崩溃恢复、单任务反复建回执限流、过期幂等保护，以及深队列公平与有界 ORM 加载；不调用图片或文字模型。

`RUN_SCHEDULER_SCALE=1` 可单独运行 `tests/test_scheduler_scale_postgres.py`。`SCHEDULER_SCALE_PAGES` 默认 50000，`SCHEDULER_SCALE_REPORT` 可指定 JSON 报告路径。2026-09-16 本轮修复后的完整回归，隔离 PostgreSQL 测得：100 个用户各 500 页，连续 12 次领取，调度锁持有中位数 0.0342 秒、最大 0.0461 秒，每次最多加载 2 个 Job 对象。该结果不含锁外 SQL 选举耗时，也不是生产吞吐保证；用于确认常规领取的全队列扫描仍在调度临界区之外。上传保护和反馈预算由[系统设置](SYSTEM_SETTINGS.md)统一维护。
