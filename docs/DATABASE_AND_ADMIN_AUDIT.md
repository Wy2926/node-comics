# 数据表与后台管理能力盘点

更新日期：2026-09-21。本文件描述本轮后台补齐后的源码与全新数据库基线，不代表公开部署或真实支付验收。

当前[初始迁移](../backend/migrations/versions/0001_payments.py)包含 **52 张应用表、478 个字段**（静态计数，不含 `alembic_version`）；[后台导航](../backend/admin-ui/src/App.tsx)有 **15 个页面**。原 48 表、428 字段和 8 页是修改前的历史快照。`ReaderEntry` / `reader_entries` 仍是查询投影，不是物理表。

## 1. 领域与管理覆盖

| 领域 | 表数 | 当前后台能力 |
| --- | ---: | --- |
| 用户、会员与额度 | 4 | 运营会员开通／续期／提前结束、限时赠送、当期补偿；历史额度、扣页账本、预占任务和操作人 |
| 产品、订阅与支付 | 16 | 产品、价格、订单、客户、订阅、账单、授权期、逐月额度、支付事件、退款与争议 |
| 翻译任务与结果 | 7 | 任务、执行与调用履历；未知结果核实／补交；生成版本、复用授权和提交回执诊断 |
| 图片、文件页与上传 | 5 | 图片元数据、引用、授权、文件页映射、上传预约及占位诊断 |
| 节点、调度与服务运行 | 8 | 节点／控制池配置、执行位、心跳、服务实例、当前异常与支付积压 |
| 阅读协调与准入 | 4 | 用户分钟预算、阅读窗口、请求保护和策略版本诊断 |
| 供应商与系统配置 | 4 | 文本／图片供应商、文本配置版本、版本化运营与请求保护规则 |
| 翻译反馈 | 3 | 筛选、具体版本关联、处理人、备注、冲突保护和处理历史 |
| 管理员审计 | 1 | 操作者、目标、脱敏前后值、原因、时间与幂等关联 |
| **合计** | **52** | **15 页；本轮新增 7 页并补齐原有页面的操作入口** |

导航：运行概览、翻译任务、计算节点、翻译供应商、图片供应商、用户管理、产品与价格、订单管理、订阅与权益、支付事件、翻译反馈、运行诊断、用量与成本、操作审计、系统设置。使用说明见[后台管理](ADMIN_CONSOLE.md)。

## 2. 全部应用表

下表列出职责与管理入口；完整字段类型、约束、索引和外键以模型及[初始迁移](../backend/migrations/versions/0001_payments.py)为准。仅保留面向空库的 `payments_0001`，不提供旧库迁移或兼容链。

### 2.1 用户、会员与额度：4 张

模型：[models.py](../backend/app/models.py)、[entitlement_models.py](../backend/app/entitlement_models.py)。查询：[user_admin.py](../backend/app/user_admin.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `users` | 身份、角色及运营会员段；用户管理支持会员开通／续期／提前结束，支付订阅独立生效 |
| `quota_periods` | 用户／模式／来源／有效期的额度桶，记录授予、已用、预占及支付授权期；用户详情提供历史分页、关联账本与预占任务 |
| `membership_operations` | 唯一操作键、操作者、请求摘要、业务参数与持久回执；用户详情提供操作历史，未知回包沿用原请求恢复 |
| `usage_ledger` | 按用户、任务、额度周期追加预占／扣减／释放／赠送／补偿／核实记录；后台分页查询，不直接编辑 |

用户页数与供应商成本分别记录。提前结束运营会员不取消支付订阅，也不重复结算已受理任务；当期补偿沿用原额度桶到期时间。

### 2.2 产品、订阅与支付：16 张

模型：[billing_models.py](../backend/app/billing_models.py)。管理：[billing_admin.py](../backend/app/billing_admin.py)、[billing_catalog.py](../backend/app/billing_catalog.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `billing_settings` | 新购买默认渠道；产品与价格页配置 |
| `billing_plans` | 产品标识和名称；产品与价格页管理 |
| `billing_plan_revisions` | 不可变权益版本，含月重绘和试用规则；产品与价格及操作审计 |
| `billing_prices` | 不可变报价、币种、周期、环境和销售状态；创建／发布／停售，新价不改变原订阅 |
| `billing_price_bindings` | 价格到渠道商品的绑定与验证；产品与价格页管理 |
| `billing_accounts` | 跨渠道试用已使用时间；订阅与权益页查询 |
| `billing_customers` | 用户到渠道／环境的客户绑定；客户列表与试用记录 |
| `billing_checkouts` | 结账意图、平台会话、试用、核实与到期状态；订单／订阅详情、试用占用、未知初购核实 |
| `billing_subscriptions` | 渠道订阅、绑定、状态、试用／付费期和下次扣款；独立订阅分页、筛选与详情 |
| `billing_invoices` | 已处理账单／交易凭据；订阅详情分页，不等同完整税务发票管理 |
| `billing_terms` | 实际授权期、关联账单与撤销时间；订阅详情分页及对应逐月额度桶 |
| `billing_events` | 已验签事件、状态、次数、重试时间与错误；支付事件全局查询、关联订单及受控重新入队 |
| `billing_orders` | 首购／续费订单、原金额、累计退款与平台交易关联；订单列表、详情及定向核实 |
| `billing_order_transitions` | 订单状态追加式流转；订单时间线 |
| `billing_refunds` | 按渠道／环境／退款编号幂等保存的逐笔退款；订单详情与金额核对；本轮新增 |
| `billing_disputes` | 按渠道／环境／争议编号幂等保存的案件；订单详情；本轮新增 |

历史订单核实已改为使用所选订单的订阅、交易或结账绑定，不再同步该用户最新购买。平台累计退款与已知成功退款之和分别展示；缺少金额／状态时保留未知，不以订单总额臆造某笔退款。代码实现不等于真实支付平台验收。

### 2.3 翻译任务与结果：7 张

模型：[models.py](../backend/app/models.py)、[plan_models.py](../backend/app/plan_models.py)、[results.py](../backend/app/results.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `jobs` | 真实计算任务、内容／配置身份、状态、原图／译图及结算；任务查询、未知结果核实／补交、诊断与统计 |
| `attempts` | 供应商请求编号、调用时间、用量及成本状态；任务详情的分页调用履历 |
| `classic_states` | OCR／译文、常规流程检查点与耗时；任务详情只展示必要元数据，不公开全文 |
| `text_calls` | 文本 LLM 每次调用的用量、成本预占和错误；任务详情及按 UTC 日期／供应商／模型汇总 |
| `translation_operations` | 用户操作键及任务／复用回执；运行诊断的提交回执 |
| `translation_results` | 每次真实生成的共享版本；运行诊断的生成版本 |
| `result_accesses` | 用户对已有结果的授权与版本；结果授权诊断、反馈关联和新增复用授权统计 |

缓存复用不创建计算任务。核实未知任务不重新调用图片模型；已释放额度的迟到结果不再次扣页。补交校验归属、尺寸比例与引用，不能把其他任务的原图改作结果。

### 2.4 图片、文件页与上传：5 张

模型：[models.py](../backend/app/models.py)、[file_pages.py](../backend/app/file_pages.py)、[upload_models.py](../backend/app/upload_models.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `assets` | 私有访问记录、哈希、存储元数据、尺寸、引用与有效期；按用户／任务／图片 ID／哈希诊断 |
| `file_pages` | 用户、文件哈希、原始页索引到原图的映射；文件页诊断 |
| `upload_reservations` | 上传预约、预期图片、期限、校验和错误；上传会话诊断 |
| `upload_ingress_leases` | 当前收流占位与到期；上传会话／用户准入诊断 |
| `upload_ingress_mutex` | 上传准入一致性锁；内部机制，无人工增删改 |

诊断中的“有效”仅表示数据库访问记录有效，不探测 R2，不返回对象密钥／签名地址，也不自动删除共享字节。

### 2.5 节点、调度与服务运行：8 张

模型：[queue_models.py](../backend/app/queue_models.py)、[health_models.py](../backend/app/health_models.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `compute_nodes` | 节点／控制池身份、能力、容量、心跳及配置；节点管理、启停、凭据轮换和运行信息 |
| `job_stages` | 阶段状态、代次、尝试与可执行时间；任务阶段与概览积压 |
| `execution_leases` | 阶段租约、节点／执行机、期限、权重及结果；任务履历、节点容量和异常 |
| `compute_claims` | 节点领取幂等回执；内部恢复机制，无编辑页 |
| `user_mode_queues` | 每模式阅读控制权与会话协调；调度使用，不等同 `reading_sessions` |
| `fairness_states` | 累计服务量与公平调度统计；内部状态，无编辑页 |
| `scheduler_mutex` | 全局事务锁与任务变更序列；内部一致性机制 |
| `service_heartbeats` | 服务实例心跳、最后成功、失败次数及错误；运行诊断的服务健康 |

当前健康页展示既有控制工作进程、维护进程、OIDC 心跳及队列／支付积压快照；历史告警、趋势和外部通知仍未建设。

### 2.6 阅读协调与准入：4 张

模型：[plan_models.py](../backend/app/plan_models.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `reading_sessions` | 阅读窗口、序号、到期和隔离状态；用户准入诊断最近最多 50 个会话，已修正原用户详情的错误查询来源 |
| `image_admissions` | 滚动分钟新增图片事件；用户准入诊断的限额、剩余及重试等待 |
| `control_admissions` | 请求保护余额和并发占位；用户准入诊断，余额为最近持久化快照 |
| `translation_policies` | 用户策略版本与指纹；用户准入诊断 |

### 2.7 供应商与系统配置：4 张

模型：[models.py](../backend/app/models.py)、[translation_models.py](../backend/app/translation_models.py)、[system_settings.py](../backend/app/system_settings.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `providers` | 图片重绘连接、模型、参数、启停和成功验证记录；图片供应商表单与真实测试 |
| `translation_providers` | 文本供应商、默认选择及 RPM；翻译供应商页 |
| `translation_provider_revisions` | 不可变文本配置和服务端密钥；运行诊断的版本历史隐藏密钥，操作者见审计 |
| `system_settings` | 当前版本化运营／保护规则和最后更新人；系统设置，历史前后值见审计 |

新增规则为普通每日页数、运营会员默认月重绘页数、普通／PLUS 调度权重。环境值只用于首次初始化；日额度按新桶生效，会员默认额度按新会员段快照，调度权重在新领取执行时使用。付费产品权益仍由不可变版本决定。

### 2.8 翻译反馈：3 张

模型：[reader_api.py](../backend/app/reader_api.py)、[feedback_models.py](../backend/app/feedback_models.py)、[feedback_review_models.py](../backend/app/feedback_review_models.py)。

| 表 | 职责与当前后台入口 |
| --- | --- |
| `translation_feedback` | 对真实任务或复用授权的具体译图反馈；按状态／问题／用户／任务筛选 |
| `feedback_admissions` | 反馈速率及当日预算；用户准入诊断，预算在系统设置调整 |
| `translation_feedback_reviews` | 追加式处理记录与原请求回执；处理人、备注、状态变化和分页历史；本轮新增 |

### 2.9 管理员审计：1 张

`admin_audit_events` 的模型、写入和查询在 [admin_audit.py](../backend/app/admin_audit.py)。操作审计按操作者、动作、目标和时间分页检索；供应商、节点、会员／额度、系统设置、任务核实、反馈和支付管理动作已接入。业务写入与审计使用同一事务；外部支付核实另记录可识别的失败事件。

## 3. 本轮新增四表的完整字段

| 表 | 全部字段 | 关键约束 |
| --- | --- | --- |
| `admin_audit_events` | `id, actor_id, action, target_type, target_id, operation_key, before, after, details, note, created_at` | 操作者外键；非空操作摘要唯一；时间／目标／操作者索引；敏感配置脱敏 |
| `translation_feedback_reviews` | `id, feedback_id, actor_id, operation_key, request_hash, from_status, to_status, note, result, created_at` | 反馈与操作者外键；`actor_id + operation_key` 唯一；反馈／时间索引 |
| `billing_refunds` | `id, order_id, provider, environment, external_id, transaction_id, amount, currency, status, event_id, occurred_at, observed_at, synced_at` | 订单外键；`provider + environment + external_id` 唯一；已知金额非负 |
| `billing_disputes` | `id, order_id, provider, environment, external_id, transaction_id, amount, currency, status, event_id, occurred_at, observed_at, synced_at` | 同上；退款／争议分别建账；金额、币种允许未知 |

既有 `billing_events` 另增 `last_retry_key / last_retry_at`，用于人工重试冲突检查与冷却；`billing_orders` 另增可空非负整数 `refunded_total`，按订单币种最小单位保存平台报告的累计退款，未知时保留空值。所有变动均进入单一初始基线；`translation_operations.descriptor` 等已有恢复字段继续保留。

## 4. 本轮完成与后续边界

原 P1 缺口已形成代码与页面入口：图片供应商、未知任务处置、反馈、会员／额度处置和历史、支付事件、逐笔退款／争议、统一审计。原 P2 中的订阅／授权期、上传／准入／回执、图片／共享结果、当前服务健康、用量成本和运营规则也已接入。

仍保留以下范围边界：

- 运行诊断只读数据库，不批量探测私有 R2，不开放内部锁、计数器或幂等回执任意重置。结果整体停用或跨用户撤销复用需另行设计。
- 服务健康是当前快照；支付同步专用心跳、历史趋势、告警留档和消息通知仍是后续能力。
- 文本金额含估算与未知消耗预占，不代表供应商对账；图片模型完整费用对账未建设。订单统计按币种保留原金额，不等于扣除退款／手续费后的净收入。
- 本站发起退款、争议举证、财务导出、用户停用、活动／兑换码、额外重绘包、云书库不在本轮范围。管理员角色仍由身份中心决定。
- 作品、章节和阅读副本仍在插件本地 IndexedDB；见 [library/store.ts](../apps/extension/src/library/store.ts)、[translation/store.ts](../apps/extension/src/translation/store.ts)、[auth/private-store.ts](../apps/extension/src/auth/private-store.ts)，不能据服务端无作品表推定后台遗漏。

## 5. 交付与验证口径

本文件依据当前源码、初始迁移与导航更新，52 表／478 字段来自迁移静态计数。全量测试、隔离浏览器截图与操作证据统一记录在[后台管理说明](ADMIN_CONSOLE.md)，历史测试数量不应当作本轮结果。

本轮没有因文档更新而执行公开部署、真实付费或生产数据库核对。真实 OIDC、支付平台与 R2 环境的上线验证仍需按实际环境单独完成。
