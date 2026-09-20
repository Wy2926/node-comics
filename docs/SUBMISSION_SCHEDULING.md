# 阅读请求保护与调度

当前接口为 `POST /v1/translation-plans`，只支持新环境和 `stripe_0001` 空库基线。

## 独立的请求保护

分钟图片准入与 HTTP 保护分开。图片预算按新 Job 精确记录，在调度锁和用户锁内检查任意滚动 60 秒：普通 30 张、PLUS 100 张。新 Job、分钟事件、页数预占与操作回执同事务提交；复用和重传不重复计数，取消／失败不返还分钟次数。详见[阅读契约](READING_TRANSLATION_CONTRACT.md)。

HTTP 保护在取得调度锁前，使用独立短事务更新数据库 `control_admissions` 的令牌桶和短租约。所有 API 副本共享保护；plan、operations、lease 各自隔离，避免高频计划阻断核实和续租。

| 环境变量 | 默认 | 含义 |
| --- | ---: | --- |
| `PLAN_MAX_BODY_BYTES` | 65536 | ASGI 层限制阅读计划 JSON 字节数 |
| `PLAN_REQUESTS_PER_MINUTE` | 300 | 每账户 HTTP 令牌补充速率 |
| `PLAN_REQUEST_BURST` | 30 | 请求桶突发容量 |
| `PLAN_REQUEST_CONCURRENCY` | 4 | 同时处理的控制请求数 |
| `PLAN_REQUEST_LEASE_SECONDS` | 60 | 崩溃后的控制请求租约回收期限 |
| `READING_SESSION_LIMIT` | 8 | 每账户有效阅读会话数 |

`CONTROL_RATE_LIMITED`、`CONTROL_BUSY` 返回 429 与 Retry-After；客户端退避控制请求。图片分钟超限返回逐项 `IMAGE_RATE_LIMITED`，全部受分钟限制时顶层 429，混合受理时 202。两种退避独立，缓存查询无需等图片分钟预算恢复。PLUS 常规没有额外每日提交次数或描述符总量限制。

## 幂等保留

`translation_operations` 的用户、operation key、请求摘要与 Job 关联永久保留。重复回放不会新建任务或扣量；被删除的访问不重新生成。已结束的分钟事件可在两分钟后清理，清理事件不删除幂等回执。阅读窗口租约到期后清除至多三页的窗口正文，保留会话 fencing 记录，阻止迟到请求重建旧窗口。

## 数据库候选选举

数据库先排除无效原图、未到执行时间、配置或语言不符、供应商执行位已满等候选，再按资源池、实时／预存类别和用户选出该用户最优页面，按公平服务时间选每个资源池与类别的前两名用户。仅把这些候选载入 Python，不按创建时间截断队头，因此大批量旧任务不能遮挡后到的低服务量用户。

全队列 SQL 窗口选举复用调用方 Session 和连接，常规只读领取在获取调度锁之前完成，只传递有界的 stage ID、执行代次和优先级／队列版本，不额外借连接或提交调用方事务。若调用方已有待写对象，先在禁止自动 flush 的作用域取得调度锁，保持 scheduler → user/job 写锁顺序。锁内以最新数据复核这些候选的阶段状态、队列、原图、节点、供应商容量和公平状态，然后分配租约。优先级或队列版本变化、阶段已被其他节点领取等竞争会放弃失效候选；本轮没有可用候选时，下轮重新选举，不沿用旧快照强行执行。

锁内原图检查只针对候选，本地存储检查文件存在性，R2 不发送 HEAD。本地原图已丢失的候选通过失败结算释放额度，下一轮可选后续页面，避免缺失队头长期遮挡。文本速率计数只读取达到阈值所需的行。第二名用户用于更新虚拟服务时间下界。实时／预存份额、普通／PLUS 权重、空闲执行位借用、30 分钟老任务优先和阅读位置排序沿用既定规则。锁外选举仍有随数据库规模增长的成本，应结合节点数和领取频率监控数据库 CPU。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_translation_plans.py tests/test_submission_limits.py tests/test_cluster_scheduler.py -q
```

真实 PostgreSQL 使用专用 `nodecomics_concurrency_test`，设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_*`，验证分钟竞争、重复操作、逐项回滚、跨副本控制保护、事务提交后通知及公平调度。`RUN_SCHEDULER_SCALE=1` 启用 50,000 页规模测试；报告锁外选举耗时和锁内持有时间，不能用它推断生产吞吐。完整本轮证据见[阅读契约验证](READING_TRANSLATION_CONTRACT.md#10-实现与验证记录)。
