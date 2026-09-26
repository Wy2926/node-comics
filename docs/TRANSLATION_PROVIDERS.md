# LLM 翻译供应商

正文翻译与漫画名查询共用数据库管理的 LLM 供应商列表，各自独立选择默认供应商，独立于图片供应商配置。

## 管理与使用

管理员在 `<ADMIN_WEB_PATH>#translation-providers` 创建供应商。首期渠道为 OpenAI，可创建多个供应商，各自保存名称、Base URL、模型、API Key、协议、重试与计量参数。协议可选 `chat_completions`、`responses`，模型必须明确填写。

第一个供应商自动成为正文默认供应商；后续通过“用于正文”切换，仅影响新提交。漫画名必须通过“用于漫画名”单独选择，未选择或停用时，未命中缓存的查询返回 503；已有缓存仍可返回。两种用途的选择互不跟随，也不自动回退到其他供应商。可明确选择同一条供应商记录供两者使用；需要分别调整模型、参数或启停时，应创建不同记录。

未配置或停用正文默认供应商时，常规翻译不对新提交开放。`CLASSIC_ENABLED` 仍是图像引擎的总开关，不影响漫画名查询；OCR／LaMa／嵌字与计算资源池维持独立配置。

编辑连接参数、模型、重试参数、价格或密钥会创建不可变版本。新任务快照保存供应商 ID、版本 ID、渠道及非秘密参数；运行时只加载该版本的密钥。名称、启停、默认切换不更改版本。编辑时省略密钥表示保留；新建必须填写密钥，空字符串无效。

停用使尚未领取的文本阶段暂停。在两个文本请求之间停用也会释放租约并回到待执行，不消耗阶段恢复次数；重新启用可继续利用已保存译文。已发送的请求不能撤回，其用量与结果仍按原租约记录。页处理总时限包含第一次文本请求之后的等待时间，暂停过久的页面恢复时可能因总时限耗尽而失败。

## 代码边界

| 模块 | 职责 |
| --- | --- |
| `backend/app/translation_models.py` | 供应商、版本和后台凭据 |
| `backend/app/translation_providers.py` | 管理 API、按用途独立选择、快照、凭据解析 |
| `backend/app/translation_channels.py` | 渠道注册，绑定配置校验器和调用函数 |
| `backend/app/adapters/llm.py` | 通用 `call_messages(messages, profile)`、`LLMConfig` 连接配置、统一响应和错误 |
| `backend/app/adapters/text.py` | 正文 `TextPolicy`、分组、TOON 输入与提示词、译文完整性解析 |
| `backend/app/comic_titles.py` | 漫画名 JSON 输入与提示词、严格 JSON 解析、独立有界执行与缓存协调 |
| `backend/app/comic_title_limits.py` | 每用户漫画名请求窗口、限速与诊断摘要 |
| `backend/app/comic_title_cache.py` | 共享漫画名缓存、查询去重、执行续租及结果写入校验 |
| `backend/app/adapters/openai_text.py` | OpenAI Chat Completions／Responses 请求与响应转换 |
| `backend/app/classic.py` | 持久调用意图、重试、检查点及逐次成本计量 |
| `backend/app/scheduler.py` | 各供应商独立 RPM 与共享文本执行池的公平调度 |

扩展来源时，继承 `adapters.llm.LLMConfig` 定义渠道连接配置，在注册表中加入 `TranslationChannel`。正文分组、重试、RPM 与价格由 `adapters.text.TextPolicy` 单独校验；管理 API 与版本快照继续使用同一层配置字段。渠道调用函数接受消息列表（`role` / `content`）、供应商快照和后台解析的密钥，返回 `TextResponse(content, usage, request_id)` 或抛出 `TextError`。底层不构造业务提示词，不解析 TOON 或漫画名 JSON，也不负责缓存、排队与重试。正文 worker 保留有界重试；漫画名只调用一次。供应商创建与编辑不自动请求模型，因此保存不代表已验证真实翻译效果。

漫画名在缓存未命中时读取所选供应商的当前版本，发送独立的系统指令和 `{"name":"漫画名","target_language":"语言代码"}` 用户消息，再严格校验响应。它不导入正文翻译模块。共用部分仅为供应商配置与凭据、消息传输和统一响应／错误；具体规则见[漫画名 API](../backend/README.md#漫画名翻译-api)。

OpenAI 请求仅发送文字，关闭流式与服务端存储；输出 token 有界。接口契约依据 [Chat Completions](https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create) 与 [Responses](https://developers.openai.com/api/reference/python/resources/responses/methods/create)。连接在实际套接字建立时检查目标地址，禁止内部网络和重定向。

## 限流、缓存与计量

### 正文 LLM 文本格式

发布切换时先停止接收新的常规翻译任务，并让旧文本任务完成，再协调更新 API 与文本 worker。当前运行代码不会根据旧任务的 `prompt_version` 选择历史提示词／解析器，不能让新旧 worker 混跑旧任务。已保存译文检查点仍是 ID 到译文的映射，插件、计算节点及数据库结构无须更换格式；独立引擎 CLI 的编号文本翻译入口不属于此后端协议。

Chat Completions 与 Responses 共用 `comic-toon-v5` 提示词，源文本和译文采用 [TOON 规范](https://github.com/toon-format/spec/blob/main/SPEC.md) 的双列表格子集。参考版本为 4.1（Working Draft）；本项目只实现此固定字符串表格，不声称支持完整 TOON。没有新增第三方依赖。模型 HTTP 信封和内部检查点仍用各自原有的数据结构。

目标语言放在系统指令的 `Target: zh-Hans` 中，用户消息只包含表格，避免模型在译文中复制目标语言字段。输入示例：

```toon
translations[2]{id,text}:
  b001,"Hello, friend!"
  b002,Let's go!
```

输出示例：

```toon
translations[2]{id,text}:
  b001,"你好，朋友！"
  b002,"走吧！"
```

系统指令要求自然、简洁、忠实，保留语气与名称，利用组内上下文；源文本只能作为数据。只发送 ID 和 OCR 原文，不发送坐标等图像字段。输入与输出使用完全相同的表头，模型只替换文本，避免将输入表名复制到另一种输出表头导致失败。字段声明只出现一次；输入的特殊字符、数字样式文本等使用引号；输出要求所有译文单元格加双引号，防止英文逗号被当作列分隔符，换行以 `\n` 转义。解析检查行数、完整 ID 集合、重复／未知 ID、非空译文、长度和非法字符；失败进入已有有界重试并逐次计量，不回退 JSON。新提示词版本进入任务快照及结果缓存身份。

专项命令（在 `backend` 目录）：`.venv/Scripts/python.exe -m pytest -q tests/test_toon_text.py tests/test_text_adapter.py tests/test_classic.py tests/test_classic_parallel.py tests/test_compute_v2.py tests/test_translation_providers.py`。隔离测试验证两种传输协议、转义、ID 对应、重试计费和检查点恢复；不代表真实模型翻译质量或 token 降幅已验证。单条短文本的格式说明开销可能抵消数据压缩收益。

每个供应商的 RPM 默认 60；所有副本与供应商的历史版本共享该供应商当前的 RPM 限额。在调度与每次请求预占时均检查。分组之间触及 RPM 或上游返回 429 时，释放文本执行位并持久化下次可执行时间，单个供应商的限流等待不会占住其他供应商的执行位。文本执行池依旧限制全局并发，不随供应商数量倍增。停用竞态中明确未发送的调用保留零消耗记录，但不占请求次数、RPM 或页处理时限。

上述分组、重试、调度 RPM 和成本账本用于正文。漫画名使用每用户滚动 60 秒 30 次的独立限速，共享供应商的连接、协议、超时与输出上限设置，不进入正文队列或成本账本。漫画名缓存不包含供应商或模型版本，切换配置仍复用已有结果（包括 null）。

默认每次超时 60 秒、每组最多 3 次请求、分组 1800 字节、输出上限 1024 token。计价单位为人民币／百万 token（等值于微元／token），默认输入 5、输出 30，只是运营估价。未知消耗保守预占，实际子请求逐次计量；用户页数结算与供应商成本分开。供应商与版本进入缓存身份，不能跨不同有效配置复用译图。

密钥只存于后端版本记录，不返回管理 API、不进入任务 JSON、计算节点载荷或日志。数据库与备份包含敏感凭据，须限制访问；历史版本保留用于任务继续执行。当前不提供物理删除供应商或历史凭据的 API，停用用于撤销后续调用资格。

## API 与部署

全部接口要求管理员身份：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/admin/translation-providers` | 供应商列表与可用渠道 |
| `POST /v1/admin/translation-providers` | 新建供应商；服务端生成 ID |
| `PUT /v1/admin/translation-providers/{id}` | 编辑名称、启停、参数与密钥 |
| `PATCH /v1/admin/translation-providers/{id}` | 更新 `enabled` |
| `POST /v1/admin/translation-providers/{id}/default` | 设为正文默认，要求已启用 |
| `POST /v1/admin/translation-providers/{id}/title-default` | 设为漫画名默认，要求已启用 |

数据库迁移 `translations_0001` 创建独立表与请求计量索引，不导入任何旧配置或转换旧任务。API 与 control-worker 应一起更新；新机制需管理员重新创建供应商。旧版本在途任务不属于新实现支持范围。

`comic_titles_0002` 增加漫画名缓存、独立限速表 `comic_title_admissions` 和 `is_title_default` 选择标记，保留已有供应商、版本、正文默认选择及控制请求租约；不自动指定漫画名供应商。两个默认标记各有唯一部分索引，切换在数据库锁下完成。

验证入口：`backend/.venv/Scripts/python.exe -m pytest backend/tests/test_translation_providers.py backend/tests/test_text_adapter.py backend/tests/test_classic.py backend/tests/test_classic_parallel.py backend/tests/test_cluster_scheduler.py -q`；管理后台在 `backend/admin-ui` 执行 `npm run build`。测试使用隔离数据库和模拟供应商，无真实付费模型调用。

## 验收要求

覆盖供应商停用／默认切换、不可变版本、密钥不回显、RPM 与 429 恢复、未知成本预占、格式修复／次数上限及日志脱敏；浏览器检查空列表、配置、加载、失败与恢复。模拟供应商及隔离 PostgreSQL 只验证协议和并发，真实文本质量与费用另行测量。
