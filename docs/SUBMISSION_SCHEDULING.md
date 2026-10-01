# 翻译请求保护与调度

当前接口为 `PUT /v1/translations/{id}`；持久任务使用 PostgreSQL，短期限流和并发准入使用 Redis 8。

## 独立的请求保护

图片准入与 HTTP 保护分开。图片预算按新 Job 在 Redis 原子检查滚动 60 秒：普通 10 页、付费会员 100 页；Lite 另按权益版本检查滚动 60 分钟 1,200 页。调度锁和用户锁保护重复检查、Job、页数预占与 UUID 回执的数据库事务；复用和重传不重复计数，取消／失败不返还次数。小时事务回滚规则见[会员额度](MEMBERSHIP_AND_QUOTAS.md#lite-的小时准入)，HTTP 保护保持原规则。

HTTP 保护在取得调度锁前，通过 Redis 原子脚本更新令牌桶与正在处理请求的短租约。所有 API 副本共享保护；translation、snapshot、history、events 分别隔离，避免提交阻断核实。SSE 使用独立的 300 秒并发租约，状态等待不持有数据库连接或调度锁；内部保护不要求客户端创建或续租会话。

| 环境变量 | 默认 | 含义 |
| --- | ---: | --- |
| `TRANSLATION_MAX_BODY_BYTES` | 65536 | ASGI 层限制翻译 JSON 字节数 |
| `TRANSLATION_REQUESTS_PER_MINUTE` | 300 | 每账户、每类 HTTP 令牌补充速率 |
| `TRANSLATION_REQUEST_BURST` | 30 | 请求桶突发容量 |
| `TRANSLATION_REQUEST_CONCURRENCY` | 4 | 每类同时处理的请求数；SSE 连接同样受此上限约束 |
| `TRANSLATION_REQUEST_LEASE_SECONDS` | 60 | 普通 HTTP 占用回收期限；SSE 固定为 300 秒 |

`REQUEST_RATE_LIMITED` 返回 429 与 Retry-After，客户端退避控制请求；`IMAGE_RATE_LIMITED` 为独立图片分钟或小时限制，只限制新增生成，小时拒绝带 `window_seconds=3600`。单图请求独立受理，不再有整窗混合状态。完成结果复用无需等待图片预算。付费常规没有额外每日提交次数或描述符总量限制。

## Redis 准入边界

后端通过 redis-py 连接池直接连接 Redis 8，不增加代理服务。滚动窗口、令牌桶、日计数和临时执行位使用短 Lua 脚本，把检查、占用、去重和过期设置放在同一次原子操作；使用 Redis 服务端时间，无分布式锁，也不逐请求清理数据库表。实现入口为 [redis_state.py](../backend/app/redis_state.py) 和 [redis_scripts](../backend/app/redis_scripts/)。原子性语义见 [Redis 官方说明](https://redis.io/docs/latest/develop/programmability/eval-intro/)。

范围覆盖供应商 RPM、新图片、翻译提交／快照／历史请求、漫画名每用户限速及全局执行位、上传连接、反馈、匿名公开申请、分析中继和支付事件人工重试冷却。账户、请求类别和供应商各自隔离；上传一次原子检查全局、用户、同一上传三个约束，旧令牌不能续租或释放新连接。临时执行位在完成时释放，异常退出由 TTL 回收；窗口中的已完成请求仍计次。

Redis 与 SQL 不构成跨库事务。Redis 先预占，SQL 保存业务回执和额度结算；分钟和其他短期次数在数据库失败或通信结果不确定时可保留至到期，不能据此重复扣用户页数。套餐小时次数在明确 SQL 回滚或会话关闭时释放；提交成功保留，嵌套事务提交将预占交给外层事务，释放失败保守保留至到期。反馈与公开申请以幂等键在 Redis 去重，数据库唯一约束永久保证回执唯一。明确未发送的供应商请求可以退回 RPM；未知是否发送则保留。

Redis 不可用时，受保护请求返回 503 `ADMISSION_UNAVAILABLE` 和重试提示，文本任务保持可恢复等待，不消耗模型调用次数；分析中继丢弃事件并维持 best-effort 204。释放失败由 TTL 收回，避免已完成业务被改成失败。就绪检查包含 Redis。任务领取、持久漫画名缓存去重、幂等和结算仍由数据库事务保证；这些业务锁不属于短期准入状态。

连接和读取超时均为 1 秒；不自动重试结果不确定的写操作，不把 Redis 地址、凭据或命令参数写入错误响应。部署隔离、持久化和升级顺序见[部署规范](DEPLOYMENT.md)。

## 幂等保留

`translation_requests` 的用户、UUID、请求摘要及 Job 关联永久保留。重复请求不新建任务或扣量；已撤销 UUID 保留墓碑，不能重新授权。Redis 分钟事件到期自动释放，不删除请求回执。客户端只在本地安排当前页与有限预读，不向服务端发送阅读优先级。

## 数据库领取

节点有余量时主动领取，中心按阶段 `available_at`、阶段 ID 排序；重试在退避到期后重新参与。每次最多读取最早的 32 个候选，在这批候选内优先领取具有有效付费授权（Lite、PLUS）或运营 PLUS 赠送的账户任务，同级保持就绪顺序，每批最多分配 4 页；不维护阅读优先级、用户服务时间、普通／付费会员精确权重或按构建指纹拆分的队列。不同节点不要求平均分配，完成快的节点可以继续领取。

SQL 先过滤取消／终态、输入元数据、目标语言、v3 协议和供应商限制，再使用 `ix_stage_ready(status,name,available_at,id)` 读取有限候选。领取复用调用方 Session 和连接，在调度锁外读取候选代次，锁内复核状态、节点容量和每次分配后的供应商容量。调用方已有待写对象时先取得调度锁，保持 scheduler → user/job 的锁顺序。

原图存在性仅检查有限候选，不读取图片正文。缺失原图进入同 UUID 补传，保留检查点与额度预占；后续有效候选可以继续领取。长轮询就绪提示只查询数据库存在性，不扫描整个队列的本地文件；提示不是执行授权，实际领取负责检查文件。并发竞争后的空批最多重选一次，然后短退避。

图像、文本、重绘和上传恢复各自按可执行条件领取；供应商 RPM、并发和未知调用保护独立保留。租约代次、领取回执和结算幂等是数据库约束，不因排序简化而取消。全局短事务锁保留，吞吐和锁等待需在目标规模下测量。

## 验证

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_translation_requests.py tests/test_submission_limits.py tests/test_cluster_scheduler.py -q
```

真实 PostgreSQL 使用专用 `nodecomics_concurrency_test`，设置 `RUN_POSTGRES_CONCURRENCY=1` 和 `TEST_PG_*`，验证分钟竞争、重复操作、独立请求回滚、跨副本控制保护、事务提交后通知及有界候选领取。`RUN_SCHEDULER_SCALE=1` 启用 50,000 页规模测试；报告领取耗时和锁内持有时间，不能用它推断生产吞吐。复验入口见[阅读契约验证](READING_TRANSLATION_CONTRACT.md#9-验证入口)。

从仓库根目录复验领取性能（先用同一 Compose 构建测试镜像）：

```sh
docker compose -p node-comics-tests -f deploy/compose.tests.yaml run --rm -e RUN_POSTGRES_CONCURRENCY=1 -e RUN_SCHEDULER_SCALE=1 tests python -m pytest tests/test_scheduler_benchmark.py tests/test_scheduler_scale_postgres.py -q -s
```

基准覆盖 1,000／50,000 页、100 个账户（25% PLUS）、1／8／32 个并发领取节点，每批最多四页，竞争空批最多重试一次。记录端到端领取 P50／P95、空领取数和领取吞吐；不包含模型执行或图片传输。对比不同实现时顺序运行相同负载，不与其他回归或真实任务混跑。
