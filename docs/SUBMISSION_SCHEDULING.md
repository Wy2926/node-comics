# 翻译请求保护与调度

当前接口为 `PUT /v1/translations/{id}`；持久任务使用 PostgreSQL，短期限流和并发准入使用 Redis 8。

## 独立的请求保护

分钟图片准入与 HTTP 保护分开。图片预算按新 Job 在 Redis 原子检查滚动 60 秒：普通 10 张、PLUS 100 张。调度锁和用户锁保护重复检查、Job、页数预占与 UUID 回执的数据库事务；复用和重传不重复计数，取消／失败不返还分钟次数。详见[翻译契约](READING_TRANSLATION_CONTRACT.md)。

HTTP 保护在取得调度锁前，通过 Redis 原子脚本更新令牌桶与正在处理请求的短租约。所有 API 副本共享保护；translation、snapshot、history 分别隔离，避免提交阻断核实。长轮询等待不持有数据库连接或调度锁；内部保护不要求客户端创建或续租会话。

| 环境变量 | 默认 | 含义 |
| --- | ---: | --- |
| `TRANSLATION_MAX_BODY_BYTES` | 65536 | ASGI 层限制翻译 JSON 字节数 |
| `TRANSLATION_REQUESTS_PER_MINUTE` | 300 | 每账户、每类 HTTP 令牌补充速率 |
| `TRANSLATION_REQUEST_BURST` | 30 | 请求桶突发容量 |
| `TRANSLATION_REQUEST_CONCURRENCY` | 4 | 每类同时处理的请求数 |
| `TRANSLATION_REQUEST_LEASE_SECONDS` | 60 | 崩溃后的内部请求占用回收期限 |

`REQUEST_RATE_LIMITED` 返回 429 与 Retry-After，客户端退避控制请求；`IMAGE_RATE_LIMITED` 为独立图片分钟限制，只限制新增生成。单图请求独立受理，不再有整窗混合状态。完成结果复用无需等待图片分钟预算。PLUS 常规没有额外每日提交次数或描述符总量限制。

## Redis 准入边界

后端通过 redis-py 连接池直接连接 Redis 8，不增加代理服务。滚动窗口、令牌桶、日计数和临时执行位使用短 Lua 脚本，把检查、占用、去重和过期设置放在同一次原子操作；使用 Redis 服务端时间，无分布式锁，也不逐请求清理数据库表。实现入口为 [redis_state.py](../backend/app/redis_state.py) 和 [redis_scripts](../backend/app/redis_scripts/)。原子性语义见 [Redis 官方说明](https://redis.io/docs/latest/develop/programmability/eval-intro/)。

范围覆盖供应商 RPM、新图片、翻译提交／快照／历史请求、漫画名每用户限速及全局执行位、上传连接、反馈、匿名公开申请、分析中继和支付事件人工重试冷却。账户、请求类别和供应商各自隔离；上传一次原子检查全局、用户、同一上传三个约束，旧令牌不能续租或释放新连接。临时执行位在完成时释放，异常退出由 TTL 回收；窗口中的已完成请求仍计次。

Redis 与 SQL 不构成跨库事务。Redis 先保守预占，SQL 保存业务回执和额度结算；数据库失败或通信结果不确定时，短期次数可保留至到期，不能据此重复扣用户页数。反馈与公开申请以幂等键在 Redis 去重，数据库唯一约束永久保证回执唯一。明确未发送的供应商请求可以退回 RPM；未知是否发送则保留。

Redis 不可用时，受保护请求返回 503 `ADMISSION_UNAVAILABLE` 和重试提示，文本任务保持可恢复等待，不消耗模型调用次数；分析中继丢弃事件并维持 best-effort 204。释放失败由 TTL 收回，避免已完成业务被改成失败。就绪检查包含 Redis。任务领取／公平调度、持久漫画名缓存去重、幂等和结算仍由数据库事务保证；这些业务锁不属于短期准入状态。

连接和读取超时均为 1 秒；不自动重试结果不确定的写操作，不把 Redis 地址、凭据或命令参数写入错误响应。部署隔离、持久化和升级顺序见[部署规范](DEPLOYMENT.md)。

## 幂等保留

`translation_requests` 的用户、UUID、请求摘要及 Job／私有结果授权关联永久保留。重复请求不新建任务或扣量；已撤销 UUID 不能重新授权。Redis 分钟事件到期自动释放，不删除请求回执。当前页优先采用一次性短时提示，重复 PUT 不续期。

## 数据库候选选举

数据库先排除无效原图、未到执行时间、配置或语言不符、供应商执行位已满等候选，再按资源池、实时／预存类别和用户选出该用户最优页面，按公平服务时间选每个资源池与类别的前两名用户。仅把这些候选载入 Python，不按创建时间截断队头，因此大批量旧任务不能遮挡后到的低服务量用户。

全队列 SQL 窗口选举复用调用方 Session 和连接，常规只读领取在获取调度锁之前完成，只传递有界的 stage ID、执行代次和优先级／队列版本，不额外借连接或提交调用方事务。若调用方已有待写对象，先在禁止自动 flush 的作用域取得调度锁，保持 scheduler → user/job 写锁顺序。锁内以最新数据复核这些候选的阶段状态、队列、原图、节点、供应商容量和公平状态，然后分配租约。优先级或队列版本变化、阶段已被其他节点领取等竞争会放弃失效候选；本轮没有可用候选时，下轮重新选举，不沿用旧快照强行执行。

锁内原图检查只针对候选，本地存储检查文件存在性，R2 不发送 HEAD。本地原图已丢失的候选通过失败结算释放额度，下一轮可选后续页面，避免缺失队头长期遮挡。文本供应商 RPM 在 Redis 批量预检，发送调用前再原子预占，竞争失败时释放执行位并持久化等待。第二名用户用于更新虚拟服务时间下界。实时／预存份额、普通／PLUS 权重、空闲执行位借用、30 分钟老任务优先和页面优先提示排序沿用既定规则。锁外选举仍有随数据库规模增长的成本，应结合节点数和领取频率监控数据库 CPU。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_translation_requests.py tests/test_submission_limits.py tests/test_cluster_scheduler.py -q
```

真实 PostgreSQL 使用专用 `nodecomics_concurrency_test`，设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_*`，验证分钟竞争、重复操作、独立请求回滚、跨副本控制保护、事务提交后通知及公平调度。`RUN_SCHEDULER_SCALE=1` 启用 50,000 页规模测试；报告锁外选举耗时和锁内持有时间，不能用它推断生产吞吐。复验入口见[阅读契约验证](READING_TRANSLATION_CONTRACT.md#9-验证入口)。
