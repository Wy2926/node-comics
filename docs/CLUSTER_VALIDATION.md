# 翻译集群重构验收记录

日期：2026-09-15。适用于全新数据库基线 `cluster_0001` 与当前前后端集群协议。产品规则见[翻译集群设计](TRANSLATION_CLUSTER_DESIGN.md)，独立节点运行方式见[计算代理说明](../services/compute-agent/README.md)。

本记录区分代码检查、隔离运行、真实浏览器、真实对象存储和生产部署。测试中的模拟供应商结果只验证协议与交互，不作为翻译效果证据。各组测试存在重叠，数量不相加。

## 当前结果

| 检查层 | 本轮证据 | 状态与边界 |
| --- | --- | --- |
| 前端测试 | 226 项通过 | 上传清单、队列、阅读优先级、恢复与结果访问等逻辑检查 |
| 前端检查与构建 | 类型检查、87 个模块的边界检查通过；Chrome MV3 与 Web 构建通过 | 构建成功不代表商店发布或线上部署 |
| 后端 SQLite 与 PostgreSQL 全量 | 306 项通过，2 条依赖弃用警告，用时 154.86 秒 | PostgreSQL 用例全部启用，没有跳过项；结果记录于 `artifacts/cluster-validation/backend-tests.xml` |
| 存储与相关后端回归 | 两组分别 98、81 项通过 | 覆盖永久保留、访问时间、上传竞态、权限、历史、缓存、取消、恢复和结算；属于全量测试的子集 |
| 常规图像引擎 | 新镜像内 20 项测试通过 | 运行时、阶段契约与局部抹字边界；未运行真实 GPU 推理 |
| 计算代理 | 8 项测试通过 | 领取、心跳、结果上报及错误处理协议 |
| 真实 HTTP 多进程 | 1 项端到端集成通过 | 真实 API、控制执行池、维护进程与两个独立代理进程；引擎和文本供应商使用模拟响应 |
| 真实 Chrome 阅读器 | 8 个场景通过，使用无限期保留的新夹具复验 | 使用真实浏览器和隔离 API；图片供应商使用模拟响应；已查看桌面与窄屏截图 |
| Docker 构建 | backend、compute-agent、classic-engine 的 `cluster` 镜像已构建；最新后端镜像已重建 | 后端在 `--network none` 下完成封装内 schema 与导入检查，输出 `PACKAGED_SCHEMA_IMPORT_OK`；未启动生产集群 |
| 配置与提交内容检查 | Compose 启用 `classic` profile 的配置检查通过；凭据扫描输出 `CREDENTIAL_SCAN_OK`；`git diff --check` 通过 | 凭据扫描覆盖已跟踪及未跟踪文件，排除 Git 忽略内容；私有环境文件未纳入交付 |
| 真实 R2 | 完整隔离链路通过 | 真实原图与译图存储、授权下载解码、两个开发来源 CORS 与清理均通过；图片供应商仍为模拟实现 |

## 已覆盖的关键行为

- 常规与 AI 重绘分别拥有同时在途容量：普通用户每模式 10 页，PLUS 每模式 500 页；上传占位参与容量和额度受理，重复提交不重复预占。
- 每模式实时名额为普通用户 2 页、PLUS 10 页；实时与预存区分优先级，会员权重可配置，空闲资源可以借用。
- 上传接收统计实际字节并校验摘要；已接收的有效上传不会被错误的重复 PUT 撤销，晚结束的 PUT 不会把已进入校验的状态改回上传状态。
- 校验和计算使用阶段租约。过期执行不能提交新代次结果；已删除对象被晚到写入重建后，孤儿清理能够再次移除。
- 原图与最终译图默认无限期保留，`expires_at = null`。签发用户授权下载时记录访问时间；模型读图和历史轮询不更新该时间。显式用户删除继续撤销原图及其结果的访问。
- 付费结果未知时保留记录供核实，不盲目重发；取消、恢复、重复完成与核实结果不造成重复业务结算。
- HTTP 多进程测试强制终止正在渲染的第一个代理，由第二个代理恢复同一页，保留已完成译文，最终只结算一次。

### Chrome 的 8 个场景

1. PLUS 显示每模式 500 页容量、10 个实时名额，暂停其中一个模式不暂停另一个模式。
2. 服务器队列暂停时，8 页清单仍能完成持久上传。
3. 关闭阅读器后，服务器继续完成全部 8 页任务。
4. 重开阅读器恢复阅读位置和已完成译图。
5. 重新翻译失败后，旧译图与阅读位置保持可用。
6. 390 像素宽度下队列可操作，没有横向溢出。
7. 普通用户显示每模式 10 页容量、2 个实时名额。
8. 隐私设置显示原图与译图长期保留、未设自动清理；窄屏长提示正常换行，不遮住主要队列内容。

截图与结构化结果写入 `artifacts/cluster-validation/`，该目录已被 Git 忽略。浏览器检查使用合成漫画，不包含用户私有原图或真实翻译效果样本。

## R2 在线检查与剩余限制

[隔离 R2 检查脚本](../scripts/verify_cluster_r2.py) 使用临时 SQLite、合成 PNG、模拟图片供应商和随机测试前缀。每次 S3 操作都会验证桶与前缀范围，结束时仅清理本次前缀，不修改产品前缀中的对象。

本轮最终结果：

- 原图与译图均使用真实 R2，保留期限为无限期；服务器持久图片文件数为 0。
- 授权 GET 返回的结果已核对字节并成功解码，用户下载访问时间已记录。
- 同幂等键重复提交返回同一回执，业务结算 1 次；模拟供应商调用 1 次，付费供应商调用 0 次。
- 共写入 3 个测试对象、删除 3 个测试对象，本次随机前缀已确认清空，产品前缀未被修改。
- `http://127.0.0.1:5174` 与 `http://localhost:5173` 两个开发来源的下载 CORS 均通过：已配置 2、缺失 0。此结果不覆盖尚未验收的生产域名或扩展来源。

脚本只输出步骤、计数、状态和错误类别，不输出凭据、对象键、签名 URL 或图片内容。

本轮还没有验证真实 GPU 推理、真实付费图片模型效果、两台物理机器上的故障恢复或生产部署。真实设备利用率、模型热身、显存、跨机网络与吞吐需要在目标硬件上测量；不能从协议测试推断设备始终满载。

## 可重复命令

以下 PowerShell 命令按注明目录执行。使用现有 Python 虚拟环境、前端依赖和 Docker；PostgreSQL 检查只使用隔离测试数据库，不使用产品数据库。

### 前端：`apps/extension`

```powershell
npm test
npm run check
npm run build
npm run build:web
```

### 后端：`backend`

默认运行临时 SQLite 用例；未启用的 PostgreSQL 用例会显示 skipped，不能算作通过。

```powershell
.venv/Scripts/python.exe -m pytest -q --tb=short
.venv/Scripts/python.exe -m pytest tests/test_compute_http.py -q
```

启用 PostgreSQL 前，在当前终端配置 `TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`。数据库必须为 `nodecomics_concurrency_test`，夹具为每例创建并清理随机 schema；数据库本身应预先准备好。

```powershell
$env:RUN_POSTGRES_CONCURRENCY = "1"
.venv/Scripts/python.exe -m pytest -q --tb=short
```

### 镜像与引擎：仓库根目录

这些命令只构建镜像或启动一次性测试容器，不启动生产服务。引擎检查只挂载三个测试文件，使用镜像内封装的实现并禁用网络。

```powershell
docker build -t node-comics-backend:cluster backend
docker build -t node-comics-compute-agent:cluster services/compute-agent
docker build -t node-comics-classic-engine:cluster services/classic-engine
docker compose --env-file .env --env-file deploy/.env.local --profile classic config --quiet
$clusterEngineSource = (Resolve-Path services/classic-engine).Path
docker run --rm --network none --entrypoint python --mount "type=bind,source=$clusterEngineSource/test_runtime.py,target=/opt/engine/test_runtime.py,readonly" --mount "type=bind,source=$clusterEngineSource/test_stage_contract.py,target=/opt/engine/test_stage_contract.py,readonly" --mount "type=bind,source=$clusterEngineSource/test_local_inpainting.py,target=/opt/engine/test_local_inpainting.py,readonly" node-comics-classic-engine:cluster -m unittest -v test_runtime.py test_stage_contract.py test_local_inpainting.py
```

代理检查在 `services/compute-agent` 目录运行，Python 环境需安装该目录的 `requirements.txt`：

```powershell
python -m unittest -v test_agent.py
```

### 浏览器：隔离 API + Web

在 `backend` 目录启动测试 API，记下输出的 `UI_FIXTURE_DIRECTORY`。该入口独立创建测试数据、禁用项目环境文件并模拟图片供应商：

```powershell
.venv/Scripts/python.exe tests/manual_ui_server.py
```

在 `apps/extension` 的另一终端启动 Web：

```powershell
npm exec vite -- --host 127.0.0.1 --port 5174 --strictPort
```

在仓库根目录设置 `UI_FIXTURE_DIRECTORY` 为上述实际输出目录，再运行：

```powershell
node scripts/verify_cluster_reader.mjs
```

此脚本需要已安装的 Chrome 和可解析的 Playwright。若 Playwright 不在默认模块路径，可通过 `PLAYWRIGHT_MODULE` 指向本机已安装模块。API 地址固定为 `http://127.0.0.1:18089`，Web 地址固定为 `http://127.0.0.1:5174`。

### 真实 R2：仓库根目录

仅在本机私有环境文件具有有效 R2 对象读写配置时执行；脚本不调用付费图片模型。

```powershell
backend/.venv/Scripts/python.exe scripts/verify_cluster_r2.py --env-file .env
```

`.env`、临时数据库、截图和运行日志均不作为仓库交付内容。没有进行生产替换、旧数据库迁移、镜像发布或公开部署。
