# 常规翻译运行说明

2026-09-16 文本供应商更新：改由数据库维护，迁移头为 `shared_0004_text_providers`。本轮仅更新代码、测试与运行说明，未部署或切换真实实例；下文历史图片与性能证据不代表新版供应商接入验收。

2026-09-16：嵌字已扩展至 16 个目标项，并整体接入固定 Manga Translator UI Qt 排版引擎；当前运行准备、版本与验收边界见[气泡与嵌字说明](LETTERING_LAYOUT.md)，字体和语言范围见[语言清单](LANGUAGE_SUPPORT.md)。下文版本与样本记录按各自日期保留。

2026-09-15：常规改为可独立部署的阶段计算节点。客户端统一使用[提交清单与双队列](TRANSLATION_CLUSTER_DESIGN.md)；原图和译图存私有 R2，中间图仅节点有界内存缓存。引擎版本 `mit-95227a2-classic-v4-cluster`，模型、字体和权重版本未升级。

## 启动

在 `.env` 填写 `CLASSIC_ENABLED=true` 和私有 R2 配置，再运行：

```powershell
./scripts/bootstrap.ps1 -Start -Classic
```

启动后以管理员身份打开 `<ADMIN_WEB_PATH>#translation-providers`，创建供应商并填写名称、OpenAI 渠道、Base URL、模型和 API Key。支持 OpenAI Chat Completions（`chat_completions`，默认）和 Responses（`responses`）；首个供应商自动成为默认。默认选择及版本化配置修改只影响新任务，已有任务固定引用 DB revision；调用时校验完整快照并从对应 revision 读取密钥，无环境变量 fallback。

停用会暂停排队文本阶段；请求间遇到停用时释放租约并回到 ready，不消耗阶段重试次数，已发生调用的计量保留。暂停时间仍计入首次文本请求之后的页处理总时限。启停和 RPM 对供应商各历史版本统一生效；每供应商 RPM 独立，与共享文本执行位分开。密钥留在后端、不出 API；数据库与备份包含敏感密钥，须限制访问。

迁移只新增供应商表及索引，无自动配置 seed，不导入旧配置，不兼容旧任务快照和旧文本供应商数据；验证使用新隔离数据库及运行目录。完整参数、暂停语义、API 和迁移边界以 [LLM 翻译供应商](TRANSLATION_PROVIDERS.md) 为准。

控制服务为 API/control-worker/maintenance；每台图像设备运行 compute-agent 和常驻 classic-engine。跨机器只通过认证 HTTPS API 通信；同机引擎无公开端口、不持有文本密钥。CPU/CUDA、第二台机器、稳定资源 ID 和锁目录见[节点部署](../services/compute-agent/README.md)。

## 阶段与恢复

1. analyze 检测和 OCR，将分块文字、置信标记和有界遮罩检查点写入数据库，释放图像租约。
2. text 调用 LLM，与 inpaint LaMa 局部抹字并行。文本等待期间图像设备可服务其他页面；每个文本调用独立记录预估成本、用量、请求标识和未知消耗。
3. 两路完成后 render 嵌字。清理图缓存丢失或换节点时重新执行本地抹字，不重发已成功文本调用。
4. 输出核验尺寸、允许区域外像素及有效租约，写 R2 后结算。空白页 no_text 不消耗页数，明确失败释放预占；部分识别保留原文并标记。

节点每阶段的重试受 `CLUSTER_STAGE_ATTEMPTS` 控制。过期租约和已完成任务的晚到结果不能重新交付。低成本 LLM 在统一次数和处理时限内重试和格式修复，未知成本继续计量预占，成本不再作为调用或重试门槛；AI 重绘不使用该文本重试策略。

## 接口与配置

| 配置或接口 | 用途 |
| --- | --- |
| `POST /v1/translation-submissions` | mode=classic、有限页数、摘要及上传会话 |
| `GET /v1/jobs/{id}/classic` | 所属用户的分块原文/译文与计量；未上传返回未就绪 |
| `GET /v1/admin/jobs` | 每次文本调用与成本计量记录 |
| `CLASSIC_ENGINE_VERSION` | 影响缓存与节点能力匹配 |
| `ENGINE_DEVICE` / `ENGINE_RESOURCE_ID` | CPU/CUDA与稳定物理设备身份 |
| `ENGINE_CACHE_BYTES` | 默认256 MiB有界中间图内存 |
| `CLUSTER_STAGE_ATTEMPTS` | 默认3次安全阶段执行 |
| `CLUSTER_TEXT_SLOTS` | 文本控制池初始并发，后续在后台修改 |
| 后台供应商 `config` | 协议、模型、RPM、分组、超时、重试和估价；见[参数说明](TRANSLATION_PROVIDERS.md#限流缓存与计量) |

模型、权重、字体来源与许可沿用现有 prepare.py 和 licenses 记录。当前完整测试与浏览器交付证据见[集群验收](CLUSTER_VALIDATION.md)。以下旧效果样本记录仅说明样本质量与当时环境，不代表本次新集群吞吐或GPU验收。

## 验证与交付边界

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
cd apps/extension
npm run check
npm test
npm run build
npm run build:web
```

需要真实 PostgreSQL 的并发测试在独立数据库及随机 schema 运行，命令见 [后端说明](../backend/README.md)。SQLite、PostgreSQL、HTTP 子进程和手工 UI fixture 通过 `backend/tests/translation_fixtures.py` 显式写入隔离 DB 供应商，使用假密钥及模拟响应；协议变化必须写新 revision 后重新获取快照。真实调用与模拟测试分别记录。

2026-09-16 DB 供应商 fixture 回归：完整后端测试 456 项通过、82 项按默认条件跳过；另在一次性 PostgreSQL 17.6 容器、独立测试库及随机 schema 中运行 `pytest tests -k postgres -q`，82 项通过、1 项调度负载基准未启用。两轮均仅有 2 条依赖弃用警告。手工阅读器／管理后台 fixture 已实际启动并经 HTTP 确认 DB 供应商及密钥不出 API；本机 smoke 等待配置逻辑通过模拟检查，未调用真实模型、运行 GPU 全链路或部署真实实例。

历史自动化验证（旧供应商实现）：后端 86 项通过，默认跳过的 6 项 PostgreSQL 用独立入口全部通过；前端 29 项通过，TypeScript 检查、Chrome MV3 扩展与 Web 构建通过。[汇总记录](evidence/classic-validation.json)

本轮浏览器使用测试按用户要求交由用户。建议依次检查：常规翻译按钮及报价、逐页完成与失败、原图／常规／重绘版本切换、语言版本、阅读位置、切换模式后自动翻译暂停、取消、重开任务恢复和结果下载。

本轮真实样例的模型配置、逐次 token 用量、耗时和结果校验见[脱敏记录](evidence/classic-live.json)。

| 样例 | 结果与计量 |
| --- | --- |
| 原创书店漫画（1024×1536） | 11 个文本块全部翻译；2 个低置信检测区域保留原文，部分完成、释放点数；一次文本请求 241 输入／353 输出 token。整项任务约 22 秒；检测与 OCR 6.00 秒、LaMa 4.61 秒、排版 0.98 秒 |
| 合成纯对白页（600×800，历史测试） | 3 个文本块完整交付、旧版本结算 1 测试点；一次文本请求 126 输入／48 输出 token。检测与 OCR 2.59 秒、LaMa 3.01 秒、排版 0.07 秒 |
| 无字页（600×800） | `no_text`，0 次文本请求，释放点数；检测约 1.89 秒 |

两份译图均为原尺寸 PNG，擦除／字形掩膜之外的 RGB 像素逐像素一致，主要对白已检查生成图片。原图、译图、清理图和掩膜保存在被忽略的 `private-test-data/classic-smoke-v2/`、`private-test-data/classic-dialogue/`，不包含在插件包。首次样例因完整性检查过严而失败，记录保留；该次没有调用 LLM。模型列表探测外另有一次小文本协议探测，20 输入／9 输出 token，不计入页面任务记录。

实际测试环境：Docker Linux、CPU 引擎 4 推理线程、宿主提供 Docker 32 逻辑 CPU／约 15.4 GiB 内存。上述是少量热启动样例的阶段耗时，不是吞吐量或并发承诺。没有完成 24 页日漫／英文漫画对照，也没有对比 BallonsTranslator；首版是可替换的图像引擎实现，不是最终质量选型。OCR 的部分低置信区域保留原文，并标为部分完成、不扣点数；OCR 整体失败、译文缺块、字体或渲染错误时整页保留原图并报错。更细的人工区域校对、GPU 并发调优和正式定价未实现。尚未公开部署。

组件版本、权重校验和及许可来源见 [常规引擎资源](CLASSIC_RESOURCES.md)。

气泡识别已接入固定版本 BallonsTranslator；排版边界、具体错误码、验证范围见[开源气泡识别与嵌字保护](LETTERING_LAYOUT.md)。引擎版本升级须与控制服务同步，本文此前的本地运行证据不表示新排版版本已部署。
