# LLM 翻译供应商

正文翻译与漫画名查询共用数据库管理的 LLM 供应商列表及按比例分流算法，各自配置权重，独立于图片供应商配置。

## 管理与使用

管理员在 `<ADMIN_WEB_PATH>#translation-providers` 创建供应商。首期渠道为 OpenAI，可创建多个供应商，各自保存名称、Base URL、模型、API Key、协议、重试与计量参数。协议可选 `chat_completions`、`responses`，模型必须明确填写。供应商上游 RPM 单独配置，与模型参数及用户业务限流分开。

“思考程度”用于正文与漫画名请求，新建及编辑旧配置时默认 `none`（关闭思考，最低档）；也可选择 `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或“供应商默认”（`provider_default`，不发送此参数）。各模型支持的档位不同，需按模型能力选择；GPT-6 Luna 支持 `none`。Chat Completions 发送 `reasoning_effort`，Responses 发送 `reasoning.effort`；OpenRouter 的 Chat Completions 兼容前者。降低思考程度优先减少推理开销，不保证固定响应时间。[OpenAI 模型说明](https://developers.openai.com/api/docs/models/gpt-6-luna)、[OpenRouter 参数说明](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)

已有供应商版本及任务快照缺少此字段时继续不发送参数；在后台编辑并保存后，新版本采用表单选定值，已提交的正文任务仍使用原版本。该设置进入供应商版本与正文结果缓存身份，无须修改数据库结构。

每条供应商记录分别配置正文权重 `text_weight` 与漫画名权重 `title_weight`，范围为 0–10000 的整数，新建时均为 1。每种用途只在已启用且对应权重大于 0 的供应商之间分流；权重 3:1 表示大量不同输入约 75%:25%，不要求合计为 100。权重为 0 时不接收该用途的新分配，但已提交的正文任务仍可使用此供应商。需要分别调整模型、参数或启停时，可创建不同记录。

分流采用稳定加权哈希：正文以原图 SHA-256 和目标语言选择供应商，在受理时固定供应商及版本，任务重放、重试与恢复均使用原快照；本人完成任务匹配使用同一分流键。漫画名先查询共享缓存，未命中时才以规范化名称和目标语言选择供应商并读取当前版本。名称去首尾空白并统一 Unicode NFC，漫画名语言代码忽略大小写。候选供应商及权重不变时，相同输入的选择在各副本间一致。修改权重仅影响后续分配，可能改变新提交的同一正文图片所选供应商；已有任务和缓存记录保留。

比例描述不同输入的长期分配份额，不是逐次 HTTP 请求轮转或供应商并发配额；缓存命中、正文分组与重试会使实际 HTTP 调用比例不同。供应商调用失败沿原有规则处理，不自动改选其他供应商。

没有已启用且正文权重大于 0 的供应商时，常规翻译不对新提交开放；没有可用漫画名候选时，仅缓存未命中的查询返回 503，已有缓存仍可返回。`CLASSIC_ENABLED` 仍是图像引擎的总开关，不影响漫画名查询；OCR／LaMa／嵌字与计算资源池维持独立配置。

编辑连接参数、模型、思考程度、重试参数、价格或密钥会创建不可变版本。新任务快照保存供应商 ID、版本 ID、渠道及非秘密参数；运行时只加载该版本的密钥。名称、启停、分流权重和上游 RPM 不更改版本；历史版本中已有的 RPM 字段原样保留，执行时统一读取供应商当前限额。编辑时省略密钥表示保留；新建必须填写密钥，空字符串无效。

停用使尚未领取的文本阶段暂停。在两个文本请求之间停用也会释放租约并回到待执行，不消耗阶段恢复次数；重新启用可继续利用已保存译文。已发送的请求不能撤回，其用量与结果仍按原租约记录。页处理总时限包含第一次文本请求之后的等待时间，暂停过久的页面恢复时可能因总时限耗尽而失败。

## 代码边界

| 模块 | 职责 |
| --- | --- |
| `backend/app/translation_models.py` | 供应商、版本与后台凭据 |
| `backend/app/translation_providers.py` | 管理 API、按用途筛选供应商、快照、凭据解析 |
| `backend/app/translation_routing.py` | 正文与漫画名共用的分流策略注册及稳定加权选择 |
| `backend/app/translation_provider_limits.py` | 跨用途共享的供应商上游请求准入，与用户业务限流独立 |
| `backend/app/translation_channels.py` | 渠道注册，绑定配置校验器和调用函数 |
| `backend/app/adapters/llm.py` | 通用 `call_messages(messages, profile, json_schema=...)`、`LLMConfig` 连接配置、统一响应和错误 |
| `backend/app/adapters/text.py` | 正文 `TextPolicy`、分组、JSON 输入与提示词、逐组输出 Schema、译文完整性解析 |
| `backend/app/comic_titles.py` | 漫画名 JSON 输入与提示词、严格 JSON 解析、独立有界执行与缓存协调 |
| `backend/app/comic_title_limits.py` | 每用户漫画名请求窗口、限速与诊断摘要 |
| `backend/app/comic_title_cache.py` | 共享漫画名缓存、查询去重、执行续租及结果写入校验 |
| `backend/app/adapters/openai_text.py` | OpenAI Chat Completions／Responses 请求与响应转换 |
| `backend/app/classic.py` | 持久调用意图、重试、检查点及逐次成本计量 |
| `backend/app/scheduler.py` | 结合供应商上游配额的文本执行池任务领取 |

扩展来源时，继承 `adapters.llm.LLMConfig` 定义渠道连接配置，在注册表中加入 `TranslationChannel`。正文分组、重试与价格由 `adapters.text.TextPolicy` 单独校验；上游 RPM 属于供应商记录，不进入 `TextPolicy` 或新模型版本的配置。渠道调用函数接受消息列表（`role` / `content`）、供应商快照、后台解析的密钥和可选关键字参数 `json_schema`（`name`、`strict`、`schema`），转换为对应协议的结构化输出参数，返回 `TextResponse(content, usage, request_id)` 或抛出 `TextError`。底层不构造业务提示词，不解析正文或漫画名 JSON，也不负责缓存、排队与重试。正文 worker 保留有界重试；漫画名只调用一次。供应商创建与编辑不自动请求模型，因此保存不代表已验证真实翻译效果。

分流算法与供应商配置、凭据及执行分离，通过 `translation_routing.py` 的 `STRATEGIES` 注册表扩展；当前策略为 `weighted`，两种用途共用入口，分别传入对应权重和业务键。

漫画名在缓存未命中时读取所选供应商的当前版本，发送独立的系统指令和 `{"name":"漫画名","target_language":"语言代码"}` 用户消息，再严格校验响应。它不导入正文翻译模块。共用部分为供应商配置与凭据、分流算法、上游请求准入、消息传输和统一响应／错误；具体规则见[漫画名 API](../backend/README.md#漫画名翻译-api)。

OpenAI 请求仅发送文字，关闭流式与服务端存储；输出 token 有界。接口契约依据 [Chat Completions](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create) 与 [Responses](https://developers.openai.com/api/reference/python/resources/responses/methods/create)。连接在实际套接字建立时检查目标地址，禁止内部网络和重定向。

## 限流、缓存与计量

### 正文 LLM 文本格式

发布时协调更新 API、文本 worker 与 maintenance，在全部进程升级后才保存超过旧版 8192 token 校验上限的供应商配置。新任务使用 `comic-json-v8` 缓存身份；已有 JSON 任务保留供应商版本及输出上限，恢复时未完成分组使用当前代码的 Schema，已完成的 ID 到译文检查点可以直接复用。运行代码不会按旧 `prompt_version` 选择历史提示词／解析器；早于 JSON 的任务须先排空。接受空译文前，计算节点须先升级为跳过空字符串绘字的版本，旧节点仍会拒绝空译文。回退到不接受空译文的节点代码前须排空这些任务；回退到只支持 8192 token 的中心代码前，先将供应商指向原版本，并排空使用更大上限的新任务。插件、计算协议格式及数据库结构无须更换；独立引擎 CLI 的编号文本翻译入口不属于此后端协议。

Chat Completions 与 Responses 共用 `comic-json-v8` 输出契约，源文本和译文只采用 JSON：顶层唯一字段为 `translations`，其值是段落 ID 到文本的对象映射。正文逐组生成严格 JSON Schema，两层对象均禁止额外字段，组内所有 ID 必填且值为字符串；提示词和本地完整性校验继续执行。使用标准库编码和解析，没有新增第三方依赖；模型 HTTP 信封和内部检查点仍用各自原有的数据结构。

Chat Completions 发送 `response_format.type=json_schema` 与 `json_schema.strict=true`；Responses 发送 `text.format` 中的同等定义。OpenRouter 同时发送 `provider.require_parameters=true`，只向支持请求参数的端点路由。正文供应商必须支持严格结构化输出；不支持时按上游错误终止，不静默移除约束。漫画名及其他未传 Schema 的通用调用保持原请求参数。[OpenAI 结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)、[OpenRouter 结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)

目标语言放在系统指令的 `Target: "zh-Hans"` 中，用户消息只包含 JSON 对象，避免模型在译文中复制目标语言字段。输入示例：

```json
{"translations":{"b001":"Hello, friend!","b002":"Let's go!"}}
```

输出示例：

```json
{"translations":{"b001":"你好，朋友！","b002":"走吧！"}}
```

系统指令要求自然、忠实，保留含义、语气、名称与音效，利用组内上下文；源文本只能作为数据。提示词要求逐 ID 翻译和不添加解释，JSON 格式、必填 ID 和禁止额外字段由 Schema 定义。只发送 ID 和 OCR 原文，不发送坐标等图像字段。输入与输出使用同一结构，模型只替换文本值；ID 始终为字符串，不能把 `"01"` 改成 `"1"`。逗号、引号、反斜杠、换行和 Unicode 按 JSON 字符串规则处理，不作为表格分隔符。解析允许 JSON 空白及键顺序变化，空字符串及纯空白译文规范化为 `""` 并保存该 ID，恢复执行不会因值为空而再次调用模型；节点行为见[计算协议](COMPUTE_PROTOCOL.md#覆盖结果与一次提交)。仍拒绝 Markdown 包裹、附加说明、额外字段、重复键（包括转义后相同的键）、缺失／未知 ID、非字符串、超过 2000 字符的译文、NUL 和未配对代理字符。只接受这一种 JSON 结构，不保留旧表格解析或格式回退；格式失败进入已有有界重试并逐次计量。提示词版本进入任务快照及结果缓存身份。

采用紧凑对象映射，避免为每段重复 `id`／`text` 字段；分组和并发设置不变，Schema 大小随组内 ID 数量增长，输入成本预占包含消息及 Schema 的 UTF-8 字节上界。输出上限允许配置 128–32768 token，须符合所选模型能力；已有版本不自动加大。响应信封读取仍有 1 MiB 硬上限。较高输出上限增加未知成本预占，不要求模型生成同样多的 token；实际消耗仍按返回用量计量。格式开销、真实 token 用量、模型延迟与错误率需用所选供应商验证。

达到 token 或其他生成限制的未完成响应仍进入有界重试。明确的 `refusal`／内容过滤响应记为 `TEXT_REFUSED`，保留用量与请求 ID 并终止，避免当作格式错误重复请求；拒绝内容不进入默认日志。严格 Schema 不替代业务校验，也不保证翻译质量。

专项命令（在 `backend` 目录）：`.venv/Scripts/python.exe -m pytest -q tests/test_json_text.py tests/test_text_adapter.py tests/test_classic.py tests/test_classic_parallel.py tests/test_compute_v3.py tests/test_translation_providers.py`。隔离测试验证两种传输协议、特殊字符和标准 JSON 转义、ID 对应、重试计费及检查点恢复；不代表真实模型翻译质量或线上任务恢复已验证。

每个供应商的上游 RPM 默认 60，范围为 1–10000，通过顶层 `requests_per_minute` 配置。正文与漫画名的实际模型调用共用此滚动 60 秒配额，所有副本与历史版本按同一供应商当前限额检查，在 Redis 滚动窗口中原子预占，不为限流加数据库锁或写计数表。缓存命中不占上游 RPM；已发送请求即使失败仍计次。上游限额不改变用户分钟请求数、翻译页数权益或模型版本。

正文在调度与每次调用前检查上游配额；分组之间触及 RPM 或上游返回 429 时，释放文本执行位并持久化下次可执行时间，单个供应商的限流等待不会占住其他供应商的执行位。文本执行池依旧限制全局并发，不随供应商数量倍增。停用竞态中明确未发送的调用保留零消耗记录，但不占请求次数、RPM 或页处理时限。

漫画名使用每用户滚动 60 秒 30 次的独立业务限速，缓存命中也计入该业务限速，超限返回 429。缓存未命中而所选供应商的本地上游配额已满时，返回 503 与 `Retry-After`，不发送模型请求，也不改选供应商。漫画名共享供应商的连接、协议、超时与输出上限设置，不进入正文队列或成本账本。漫画名缓存不包含供应商、权重或模型版本，修改分流比例、上游 RPM 和模型配置仍复用已有结果（包括 null）。

默认每次超时 60 秒、每组最多 3 次请求、分组 1800 字节、输出上限 1024 token。计价单位为人民币／百万 token（等值于微元／token），默认输入 5、输出 30，只是运营估价。未知消耗保守预占，实际子请求逐次计量；用户页数结算与供应商成本分开。供应商与版本进入缓存身份，不能跨不同有效配置复用译图。

密钥只存于后端版本记录，不返回管理 API、不进入任务 JSON、计算节点载荷或日志。数据库与备份包含敏感凭据，须限制访问；历史版本保留用于任务继续执行。当前不提供物理删除供应商或历史凭据的 API，停用用于撤销后续调用资格。

## API 与部署

全部接口要求管理员身份：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/admin/translation-providers` | 供应商列表与可用渠道 |
| `POST /v1/admin/translation-providers` | 新建供应商；服务端生成 ID |
| `PUT /v1/admin/translation-providers/{id}` | 编辑名称、启停、正文／漫画名权重、上游 RPM、参数与密钥 |
| `PATCH /v1/admin/translation-providers/{id}` | 更新 `enabled` |

创建和完整编辑请求在顶层传入 `text_weight`、`title_weight`、`requests_per_minute`，与 `config` 内的模型参数分开；省略时两项权重均按 1、上游 RPM 按 60 处理。旧的 `/default`、`/title-default` 选择接口已移除。

数据库从 `translations_0001` 空库基线迁移至 `quota_campaigns_0006`。`text_routing_0003` 将原正文、漫画名默认标记分别转换为对应权重 1，其余权重为 0，并删除旧标记及唯一索引；`redis_admission_0004` 删除短期限流及上传门禁表。已有供应商、不可变版本、任务和缓存保留；原来未选择漫画名供应商时，升级后需配置大于 0 的漫画名权重。全部 API、worker 和 maintenance 共用 Redis 命名空间并运行相同版本；切换前排空在途上传，首次切换短期计数重新开始，见[部署规范](DEPLOYMENT.md)。

验证入口：`backend/.venv/Scripts/python.exe -m pytest backend/tests/test_translation_providers.py backend/tests/test_text_adapter.py backend/tests/test_classic.py backend/tests/test_classic_parallel.py backend/tests/test_cluster_scheduler.py -q`；管理后台在 `backend/admin-ui` 执行 `npm run build`。测试使用隔离数据库和模拟供应商，无真实付费模型调用。

## 验收要求

覆盖两种用途的分流比例、稳定选择、权重修改与停用、任务快照和缓存保持、不可变版本、密钥不回显、思考程度传输、共享上游 RPM 的并发准入与恢复、用户限流隔离、未知成本预占、格式修复／次数上限及日志脱敏；浏览器检查空列表、配置、加载、失败与恢复。模拟供应商及隔离 PostgreSQL、Redis 只验证协议和并发，真实文本质量与费用另行测量。
