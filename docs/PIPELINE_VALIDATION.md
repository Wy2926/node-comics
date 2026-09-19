# 非 LLM 流水线改造验收

2026-09-19，前次流水线改造记录。其中心像素验收与结果 PUT 已被后续[节点直传](DIRECT_UPLOAD_VALIDATION.md)替换，以下耗时与计数是当时证据。公开 VPS 未部署。图像执行使用 RX 6900 XT Vulkan；此次性能检查用生成样张与固定文本回复，没有调用外部 LLM。此前在线文本接入证据见[本机运行记录](CLASSIC_LOCAL_RUNTIME.md)。

## 已实施

- 正常上传在接收缓冲中完成大小、摘要和解码校验，直接写入正式内容对象：一次 PUT、无校验回读。持久写入意图只用于不确定结果恢复。
- 下载、分析提交、计算、结果交付使用独立有限线程池。等待文本不占计算线程；页面缓冲与恢复日志分别设限。默认 8 页租约、2 个计算步骤、下载与交付各 4 个线程。
- 数据库事务提交后发通知，节点立即获取译文，阅读器立即同步游标并下载。长轮询不占业务数据库连接，超时与重连从持久数据恢复。
- 后台分列网络、排队、计算、文本等待及中心验收时间，整页租约改名为“整页执行与交付”。这些可重叠的时间不能相加作为 GPU 耗时。
- 删除旧三阶段 API、旧 compute-agent、旧节点配置覆盖和旧上传状态分支。当前本机使用新库 `nodecomics_pipeline_20260919` 与新节点日志目录，没有迁移旧任务；R2 原图与最终图保留。

## 本机四页实测

通过正式 HTTPS 提交与上传 API，两个隔离开发账户各提交两张 720×600 生成样张，使用真实 PostgreSQL、AMD GPU 和私有 R2。先阻塞文本池，确认四页分析均已提交且没有文本调用；随后通过控制执行器交付四组固定译文，四页全部完成中心像素验收和 R2 持久交付。完成后恢复文本池原配置。

| 指标 | 实测范围或结果 |
| --- | --- |
| 四页全部提交分析，从开始上传计时 | 3.08 秒 |
| 每页上传提交、校验、持久写入及完成回执 | 1.22–1.48 秒 |
| 节点原图下载 | 0.55–0.70 秒 |
| 每页纯图像计算：分析＋抹字＋嵌字编码 | 0.515–0.625 秒 |
| 分析提交请求 | 0.11–0.20 秒 |
| 中心原图 GET | 0.25–0.27 秒 |
| 中心像素验收 | 0.026–0.042 秒 |
| 中心结果 PUT | 0.67–1.23 秒 |
| 中心交付总计 | 1.01–1.56 秒 |
| 文本提交完成至该页成功终态 | 1.22–1.85 秒 |
| 四页从开始上传至全部成功 | 7.28 秒 |

四页总耗时包含人为阻塞文本、等待全部分析完成及启动固定回复执行器的时间，不能据此计算持续吞吐或宣称线上达到两页／秒。样张尺寸、内容和网络位置也不等于自然漫画章节。此记录用于确认计算资源能继续推进其他页面，并区分非 LLM 成本。

另定位到本机控制连接延迟：HTTPS 仅绑定 IPv4，而 `localhost` 每次新建连接为 2.04–2.07 秒；换成 `127.0.0.1` 并保持相同证书验证后为 5–6 毫秒。启动器和本机节点已修正。修正前同类四页检查全部提交分析为 6.48 秒、全部交付为 11.98 秒；这是两次样张检查，不是消除网络波动后的基准。当前主要非 LLM 网络成本仍是 R2 下载、中心原图读取和结果写入。

脱敏报告位于被忽略的 `artifacts/pipeline-live-report.json`、`pipeline-live-before-ipv4.json`、`pipeline-loopback-probe.json`。不提交图片、OCR、令牌或签名地址。

## 自动与浏览器验证

| 检查 | 结果与边界 |
| --- | --- |
| 后端全量默认测试 | 528 passed、101 skipped；跳过项不计通过 |
| 独立 PostgreSQL 并发／计算／调度／上传 | 60 passed，随机 schema，与业务库隔离 |
| classic-engine 算法与节点 | 61 passed |
| 真实 Vulkan 英文／日文样张 | 2 passed；固定译文、隔离对象适配器 |
| 插件 | 267 passed、类型与 99 模块边界检查通过、Chrome MV3 构建通过 |
| React 管理后台 | 5 passed、类型检查与构建通过 |
| 真实浏览器，隔离数据 | 任务耗时表可读；新节点配置保存版本成功；阅读器收到完成后约 44 毫秒开始下载译图，阅读位置保持 |
| 本机服务 | 新 schema、控制执行器与真实 GPU 节点就绪，四页 GPU＋R2 成功终态 |

各组用例有重叠，不相加。覆盖文本阻塞时其他页继续分析、单页交付阻塞不拖住其他页、内存限额背压、取消与租约过期、停止租约重启、冻结结果重交、上传并发与取消、写后丢响应恢复、过期租约禁止发布、跨用户通知隔离以及 PostgreSQL 跨进程提交唤醒／回滚不通知。后端有两条 FastAPI／Starlette 依赖弃用警告，无测试失败。

浏览器使用隔离夹具与应用内 Chromium；没有验收已安装 Chrome 扩展的真实源站采集，也没有验收公开 VPS、自然漫画质量或持续多页吞吐。

## 可重复命令

使用既有 Python／Node 环境，在仓库根目录执行后端与真实硬件检查：

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q --tb=short
services/classic-engine/.venv-ncnn/Scripts/python.exe -m pytest services/classic-engine/tests -q
$env:CLASSIC_TEST_MODELS = (Resolve-Path services/classic-engine/models).Path
services/classic-engine/.venv-ncnn/Scripts/python.exe -m pytest backend/tests/test_compute_node_v2.py -k real_vulkan -q
backend/.venv/Scripts/python.exe scripts/local_classic.py ready
git diff --check
```

PostgreSQL 用例只允许隔离库 `nodecomics_concurrency_test`。准备此库后，在当前进程配置 `TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`，然后运行：

```powershell
$env:RUN_POSTGRES_CONCURRENCY = '1'
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_postgres_concurrency.py backend/tests/test_compute_v2_postgres.py backend/tests/test_cluster_scheduler_postgres.py backend/tests/test_upload_ingress_postgres.py -q --tb=short
```

在 `apps/extension` 执行 `npm test`、`npm run check`、`npm run build`；在 `backend/admin-ui` 执行 `npm test`、`npm run build`。浏览器夹具入口为 `backend/tests/manual_admin_server.py` 与插件 Vite 服务的 `/tests/reader-fixture.html?auto=pipeline`。四页真实 R2 检查曾临时关闭本机文本池，仅适合无其他活跃任务的隔离本机环境。
