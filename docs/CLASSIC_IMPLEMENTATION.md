# 常规翻译运行说明

2026-09-14 实现：`classic` 与原有 `redraw` 并存。常规模式复用 manga-image-translator 固定提交的检测、48px OCR、LaMa Large 和字体渲染模块；Node Comics 管理文本接口、持久化任务、预算和用户权限。模型列表和小型文本请求已连通用户提供的兼容网关，使用 `gpt-5.6-luna`、`POST /v1/chat/completions`。没有用图片编辑模型执行常规翻译。

2026-09-15 更新：LaMa 改为文字区域裁切推理，单块输入上限 512，背景边距 48 像素，合并间距 24 像素。OCR 后文本翻译与局部擦字并行，两路完成后嵌字；清理图单独保存为本地检查点。当前引擎版本为 `mit-95227a2-classic-v3-parallel`。已完成代码、隔离验证和本地 Docker 服务切换；API、调度器、两类 worker 及引擎运行新版，实际 HTTP 图像步骤与无字页任务链路检查通过，未新增付费文本调用。详见[局部擦字与单页并行](CLASSIC_LOCAL_INPAINTING.md)和[切换记录](evidence/classic-deployment.json)。

## 启动

Docker Desktop 使用 Linux 容器；首次启动需要下载 CPU 推理依赖与模型。API、数据库与引擎各自使用本项目容器和数据卷。引擎没有宿主机端口，不获得文本或图片供应商密钥。

在根目录 `.env` 配置以下内容（不要提交密钥）：

```dotenv
CLASSIC_ENABLED=true
CLASSIC_COST=1
TEXT_BASE_URL=https://sub2api.nodelane.net/v1
TEXT_API_KEY=自行填写
TEXT_MODEL=gpt-5.6-luna
TEXT_PROTOCOL=openai_chat
```

```powershell
./scripts/bootstrap.ps1 -Start -Classic
cd apps/extension
npm ci
npm run dev
```

阅读器：[http://127.0.0.1:5173](http://127.0.0.1:5173)。登录本地测试账号，导入图片或原创示例，在“翻译方式”选“常规翻译”，确认报价后创建任务。常规翻译默认每成功版本 1 测试点；图片重绘仍为 8 点。这是测试额度，与人民币成本分开。

后续 Compose 命令都带两个环境文件与 profile：

```powershell
docker compose --env-file .env --env-file deploy/.env.local --profile classic ps
docker compose --env-file .env --env-file deploy/.env.local --profile classic up -d --build
```

`deploy/.env.local` 自动生成数据库密码、登录签名密钥和引擎令牌。引擎健康后 classic worker 才启动；首次模型下载时间不代表热启动单页耗时。`redraw-worker` 与 `classic-worker` 消费独立队列，常规并发默认 1，CPU 推理默认 4 线程。停止服务保留数据卷即可，不要在已开始的图片重绘调用中强制结束 worker。

## 已实现的处理与恢复

1. 校验原图、模式和目标语言，通过同一套报价／批次入口预占用户点数。
2. 独立引擎检测文字、执行 OCR、合并排序文字行、精化文字像素掩膜。未检测到文字返回 `no_text`，不请求文本服务且释放点数；检测到文字但 OCR 全部失败则报错。部分检测区域没有可靠识别时保留对应原文区域，并将输出标为部分完成、不扣用户点数。
3. OCR 完成后同时启动文本翻译和局部擦字。文本一路把有序文本块按 UTF-8 大小分组、依次调用，只发送文本、固定 ID 和目标语言。目标响应须包含全部且唯一的 ID，拒绝缺块、空白、额外字段和截断；有限代码围栏在本地去除。
4. 每次调用前锁定任务、检查有效执行权并提交一条 TextCall，先占用整次请求的成本上界。成功译文与该次用量一起提交；网络错误和格式错误共用每组最多 3 次调用。
5. 擦字一路根据文字掩膜合并邻近区域、保留背景边距后裁切，LaMa 逐块推理；超大区域继续切分，不自动回退整页推理。每块读取原图，只贴回归属该块的文字掩膜像素。清理图先验证并存为本地检查点；两路成功后才调用嵌字步骤，保存擦除掩膜、字形掩膜和最终图。检查 PNG 解码、原尺寸与允许区域外的 RGB 像素一致性，保留源图 alpha。
6. 合格译图作为独立模式／语言／版本的私有资产交付，用户点数结算一次。检测或本地渲染异常最多恢复 3 次；租约过期可重新投递。已保存的 OCR、译文和渲染结果可以复用，文本调用历史及预算不会重置。

取消或删除会在阶段边界停止后续调用；已经发出的文本请求仍保留消耗记录。旧执行进程的晚到回复只更新自身用量，不覆盖新执行进程的译文或清理图。文本一路失败时等待已经启动的本地擦字退出后再结束任务；擦字失败后停止新文本组及后续文本重试，已发出调用仍记账并保存有效译文，供本地恢复复用。嵌字失败可复用两路检查点。文本预算耗尽返回普通失败，用户点数释放，未知供应商成本仍保留。`redraw` 的未知结果继续禁止自动重发。

所有处理中间数据继承原图的账户隔离、到期与删除规则。OCR 和译文存在私有数据库检查点，不进入日志；诊断图片通过原有 Bearer 资产接口访问。默认只使用同页上下文，没有跨页历史、术语表、备用文本供应商或人工编辑器。

## 接口与配置

| 接口 | 内容 |
| --- | --- |
| `GET /v1/capabilities` | 两种模式的启用状态与测试点数 |
| `POST /v1/translations/classic` | multipart 图片或已有 `asset_id`，以及 `target_language` |
| `POST /v1/quotes` | `mode: classic`，支持现有批次和预算确认 |
| `GET /v1/jobs/{id}/classic` | 仅所属用户可读的分块原文、译文、诊断图片 ID 和耗时；原图失效返回 410 |
| `GET /v1/admin/jobs` | 每次文本调用的 request ID、模型、用量、状态及估算／未知预占 |

缓存／报价版本包含引擎实现版本、检测与 OCR、LaMa、掩膜、字体、阅读顺序、文本模型／端点／协议、提示词及费率和限制。模型、权重或实际处理代码升级时同步更新 `CLASSIC_ENGINE_VERSION` 和引擎 `ENGINE_VERSION`；版本不匹配时拒绝继续处理旧任务。

| 环境变量 | 默认值／单位 |
| --- | --- |
| `CLASSIC_ENGINE_URL` / `CLASSIC_ENGINE_TOKEN` | 内网引擎地址与服务令牌 |
| `CLASSIC_TIMEOUT_SECONDS` | 900 秒，页内文本处理总期限／单次本地引擎等待上限 |
| `CLASSIC_LOCAL_ATTEMPTS` | 3 次本地执行（含首次） |
| `TEXT_TIMEOUT_SECONDS` / `TEXT_MAX_ATTEMPTS` | 60 秒／每组最多 3 次，SDK 无隐式重试 |
| `TEXT_GROUP_BYTES` / `TEXT_MAX_OUTPUT_TOKENS` | 1800 字节文本组／1024 输出 token |
| `TEXT_PAGE_BUDGET_MICROS` | 50000 micro-CNY，即按配置估价每页 0.05 元 |
| `TEXT_INPUT_RATE` / `TEXT_OUTPUT_RATE` | 5／30 元每百万 token，当前为运营估价参数 |
| `TEXT_PRICING_VERSION` | `operator-estimate-v1` |
| `TEXT_PROTOCOL` | `openai_chat`；另支持 `openai_responses`，后者仅契约测试 |

**网关没有提供已核实的实际费率。** 当前人民币数值是显式运营估价，不能当成实际账单或实际费用的保证。调用使用 token 用量乘配置费率计入 `estimated`；无用量、超时及不明确响应保持 `unknown`，按请求输入字节上界与输出上限继续占用预算。实际账单需与该网关核对并更新费率。异常上报的高用量如超过原预占，会保留实际 token 计算值并阻止后续调用。

## 验证与交付边界

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
cd apps/extension
npm run check
npm test
npm run build
npm run build:web
```

需要真实 PostgreSQL 的并发测试在独立数据库及随机 schema 运行，命令见 [后端说明](../backend/README.md)。测试替换全部供应商与引擎调用，真实调用与模拟测试分别记录。

最终自动化验证：后端 86 项通过，默认跳过的 6 项 PostgreSQL 用独立入口全部通过；前端 29 项通过，TypeScript 检查、Chrome MV3 扩展与 Web 构建通过。[汇总记录](evidence/classic-validation.json)

本轮浏览器使用测试按用户要求交由用户。建议依次检查：常规翻译按钮及报价、逐页完成与失败、原图／常规／重绘版本切换、语言版本、阅读位置、切换模式后自动翻译暂停、取消、重开任务恢复和结果下载。

本轮真实样例的模型配置、逐次 token 用量、耗时和结果校验见[脱敏记录](evidence/classic-live.json)。

| 样例 | 结果与计量 |
| --- | --- |
| 原创书店漫画（1024×1536） | 11 个文本块全部翻译；2 个低置信检测区域保留原文，部分完成、释放点数；一次文本请求 241 输入／353 输出 token。整项任务约 22 秒；检测与 OCR 6.00 秒、LaMa 4.61 秒、排版 0.98 秒 |
| 合成纯对白页（600×800） | 3 个文本块完整交付、结算 1 测试点；一次文本请求 126 输入／48 输出 token。检测与 OCR 2.59 秒、LaMa 3.01 秒、排版 0.07 秒 |
| 无字页（600×800） | `no_text`，0 次文本请求，释放点数；检测约 1.89 秒 |

两份译图均为原尺寸 PNG，擦除／字形掩膜之外的 RGB 像素逐像素一致，主要对白已检查生成图片。原图、译图、清理图和掩膜保存在被忽略的 `private-test-data/classic-smoke-v2/`、`private-test-data/classic-dialogue/`，不包含在插件包。首次样例因完整性检查过严而失败，记录保留；该次没有调用 LLM。模型列表探测外另有一次小文本协议探测，20 输入／9 输出 token，不计入页面任务记录。

实际测试环境：Docker Linux、CPU 引擎 4 推理线程、宿主提供 Docker 32 逻辑 CPU／约 15.4 GiB 内存。上述是少量热启动样例的阶段耗时，不是吞吐量或并发承诺。没有完成 24 页日漫／英文漫画对照，也没有对比 BallonsTranslator；首版是可替换的图像引擎实现，不是最终质量选型。OCR 的部分低置信区域保留原文，并标为部分完成、不扣点数；OCR 整体失败、译文缺块、字体或渲染错误时整页保留原图并报错。更细的人工区域校对、GPU 并发调优和正式定价未实现。尚未公开部署。

组件版本、权重校验和及许可来源见 [常规引擎资源](CLASSIC_RESOURCES.md)。
