# RX 6900 XT 原模型部署与验收

2026-09-16 文本供应商更新：本机启动后在 `/admin/#translation-providers` 创建 DB 供应商；本轮未重新运行真实 AMD／R2／付费文本链路，也未部署真实实例。以下性能和图片记录保留原验证范围。

2026-09-16 后续更新：当前 AMD 入口为 `mit-95227a2-classic-v4-dml-v4`，修复英文断词字典重复下载；预下载指定语言、离线校验及新版本切换见[字典说明](HYPHENATION_DICTIONARIES.md)。下文的 v1/v2/v3 性能记录保留原测试日期与范围。

持续吞吐、并发排队与资源占用见 [AMD 负载测试](AMD_LOAD_TEST.md)。

2026-09-16 更新：AMD 默认入口已升级为 v3，在 GPU OCR 和分镜进程基础上增加图像缓存复用、两个 LaMa 裁剪进程，并修正等待 LLM 的图像水位计数，见 [流水线优化](AMD_PIPELINE_OPTIMIZATION.md)。v2 的对照保留在 [单张速度优化](AMD_SINGLE_PAGE.md)。下方「实际证据」保留 9 月 15 日 v1 的在线任务结果；后续版本另行验证本地图像流水线，未重复付费文本调用及 R2 全链路。

2026-09-15，本机 Windows、RX 6900 XT 16 GiB。已完成真实常规翻译、R2 上传与授权下载、CPU/AMD 同图对照。此入口使用本地开发认证和独立 SQLite 数据库，不代表公开部署或 PostgreSQL 多机验收。

## 最终方案

保留 `manga-image-translator@95227a2bb0fd306cd4f0c104d57284026f991b3a` 的检测器、48px OCR、漫画版 LaMa Large、文字区域合并、掩膜细化与原嵌字器。权重、字体及 SHA-256 均沿用 [prepare.py](../services/classic-engine/prepare.py)。没有采用 RapidOCR / MI-GAN 替换方案。

| 部分 | 实际设备 |
| --- | --- |
| 原检测网络 | RX 6900 XT / DirectML |
| 原 OCR 视觉骨干与编码器 | RX 6900 XT / DirectML |
| 原 OCR 自回归解码、颜色预测及束搜索张量运算 | RX 6900 XT / DirectML；Python 控制与结果后处理仍在 CPU |
| 原 LaMa 空间网络 | RX 6900 XT / DirectML，两个独立裁剪进程 |
| LaMa 的 36 个 FourierUnit（含内部 1×1 卷积） | CPU；保留原始 FFT 运算 |
| 区域合并、掩膜处理、字体嵌字 | CPU，原实现 |
| 原分镜检测 | 独立 CPU 进程，与检测/OCR 重叠执行 |
| 文本翻译 | 配置的在线 LLM，控制服务调用 |

v1 因 DirectML 解码结果偏离 CPU 而保留 CPU 解码。v2 定位到缓存切片写入偏差，使用等价的非原地缓存更新，保留权重、阈值、束搜索及解码数学运算；样本 OCR、掩膜、字形和整页像素均与 v1 相同。LaMa 的复杂数/FFT 模块保持在 CPU，其余网络在 GPU。检测/编码/解码/修复都有实际模块调用和输入、权重设备记录；不能把这称为全部计算都在 GPU。

Windows 环境固定 `torch-directml==0.2.5.dev240914`、`torch==2.4.1`、`torchvision==0.19.1`。PyTorch 显示 `2.4.1+cpu` 是宿主 wheel 标识，DirectML 插件通过 `privateuseone:0` 使用显卡。原 CPU/CUDA Docker 路径仍使用既有 PyTorch 2.5.1。DirectML 包许可证与第三方说明保存在 `services/classic-engine/licenses/torch-directml-*`。

## 本机启动

环境要求：Python 3.11、Git、AMD 显卡驱动。首次安装 `pydensecrf2` 可能需要 Visual Studio C++ Build Tools。本机已完成安装和权重校验。

仓库根目录：

```powershell
# 首次准备并启动。安装固定依赖、校验原模型，然后运行本地集群。
./scripts/start-local-amd.ps1 -Setup

# 后续启动；Ctrl+C 停止本次启动的服务。
./scripts/start-local-amd.ps1

# 一页真实翻译验证；无默认供应商时保持服务运行，等待后台创建后继续。
# 验证结束后关闭本次服务。
./scripts/start-local-amd.ps1 -Smoke
```

入口沿用 API、control-worker、maintenance、compute-agent、classic-engine 的职责与 HTTPS/令牌协议。本机进程之间显式允许回环 HTTP，API 为 `http://127.0.0.1:18088`，引擎为 `http://127.0.0.1:18090`。所有服务只在回环地址监听，图像节点不获得 R2 或供应商密钥。

私有 `.env` 配置 R2。脚本启动后会提示管理地址 `http://127.0.0.1:18088/admin/#translation-providers`，本地开发管理员用户名为 `admin`。在后台填写文本端点、模型和密钥，选择 OpenAI Chat Completions（默认）或 Responses；首个供应商自动成为默认。`-Smoke` 在没有启用的默认供应商时保持服务运行并等待，配置完成后自动继续。脚本不再读取旧文本密钥或回退到图片供应商密钥；服务未就绪或端口被占用时启动失败。

配置和默认选择只影响新任务；已有任务绑定 DB revision。数据库和备份含敏感密钥，必须限制访问权限。独立 RPM、停用暂停与总时限、API 及迁移边界见 [LLM 翻译供应商](TRANSLATION_PROVIDERS.md)。新表无自动配置 seed，不导入旧配置，不兼容旧任务快照和旧文本供应商数据；首次验证本版请使用下方 Python 命令指定全新的 `--directory`，PowerShell 包装脚本的固定目录不应直接沿用旧任务。

PowerShell 包装脚本将本地数据库、令牌、任务回执和验证图片放在被 Git 忽略的 `private-test-data/local-amd-nodes/`；历史图片证据在 `private-test-data/amd-original-models/`。原图和最终译图仍保存私有 R2。本版新建的验证目录重跑时沿用原任务，不重复调用已完成的文本任务；旧快照不能沿用，换图或换模型版本也需使用不同验证目录：

```powershell
backend/.venv/Scripts/python.exe scripts/run_local_node.py --device directml:0 --smoke --directory private-test-data/amd-db-text-v1 --image samples/starlight-bookshop.png
```

Docker 控制端连接独立 AMD 节点时，设置 `CLASSIC_ENGINE_VERSION=mit-95227a2-classic-v4-dml-v4`。当前引擎版本为 `mit-95227a2-classic-v4-dml-v4`，与 v1/v2/v3 及 CPU/CUDA 的结果缓存分开。调度仍严格匹配版本；当前未实现不同配置任务自动分流到多种模型池。节点能力、设备锁、租约与缓存恢复保持一致；节点身份、注册与容量已改为[后台配置](NODE_CONFIGURATION.md)。

## 实际证据

使用项目原创 `samples/starlight-bookshop.png`（1024×1536，英文→简体中文），没有使用模拟模型回复。

| 检查 | 结果 |
| --- | --- |
| 原 Docker CPU PyTorch 2.5.1 vs AMD 检测/OCR | 11 个文本块，文字内容完全一致 |
| 原 Docker CPU vs AMD 抹字掩膜 | 像素完全一致 |
| 修复区域平均绝对像素差，0–255 色值 | 约 0.000560；最大单通道差 6 |
| 使用同一份真实译文、同一原嵌字器比较 | 字形掩膜完全一致；整页约 0.00159% 像素有差异 |
| 掩膜与字形之外 | 原图像素完全不变 |
| CPU 检测/OCR + 修复 | Docker 基线 7.79 + 4.37 秒；Windows CPU 6.76 + 4.11 秒 |
| AMD 检测/OCR + 修复 | 对照运行 4.88 + 1.36 秒 |
| 最终在线整页 | 11/11 文本块完成；五个阶段全部 succeeded |
| 最终在线图像阶段 | 检测/OCR 4.656 秒、修复 1.531 秒、嵌字 0.609 秒 |
| 最终在线总耗时 | 48.859 秒，包含 R2、文本服务、调度与下载 |
| 最终在线文本调用 | 1 次，241 输入 / 331 输出 token；记录配置费率估算成本 |
| 数据交付 | 原图和译图均从真实 R2 授权下载、解码并核对尺寸 |
| 引擎回归 | 20 项通过，包含 Windows 跨进程设备锁与阶段缓存恢复 |
| 后端相关回归 | 23 项通过，包含配置缓存身份和真实 HTTP 多进程恢复；2 条依赖弃用警告 |

上述耗时是单样本测量，不是吞吐承诺。已查看原图、修复图、最终译图和并排对照。该样本中原方案本身有 2 个未识别区域，AMD 保持相同的质量标记和原文保护；没有把它报告为无遗漏翻译。尚未覆盖日文竖排、韩文、密集网点或长条漫画质量集。

本次已清空此前所有 Docker 容器和数据卷。原 CPU 镜像对照使用一次性 `--rm --network none` 容器，结束后移除；最终容器与数据卷均为 0。

## 可重复对照

```powershell
# 无文本费用；先分别保存原模型 CPU、AMD 的 OCR、掩膜和修复图。
services/classic-engine/.venv/Scripts/python.exe scripts/verify_amd_models.py --device cpu
services/classic-engine/.venv/Scripts/python.exe scripts/verify_amd_models.py --device directml:0

# 复用在线任务的同一份译文，不再调用 LLM。
services/classic-engine/.venv/Scripts/python.exe scripts/compare_amd_results.py --cpu-directory cpu
```

原 Docker 2.5.1 对照入口是 [verify_original_engine.py](../scripts/verify_original_engine.py)，在已有原引擎镜像内执行；将已校验的 `engines/mit-models` 挂载到 `/models`，样本挂载到 `/source.png`，脚本挂载到 `/opt/engine/cpu_baseline.py`，输出目录挂载到 `/output`。使用 `--rm --network none --entrypoint python`，运行 `/opt/engine/cpu_baseline.py`，不启动数据库或调用任何供应商。

私有证据：`amd-original-models/result.png`、`comparison.png`、`report.json`、`parity-report.json`、`profiles/execution-summary.json`；对照中间结果在 `amd-parity/`。图片文字、令牌和任务数据库不进入仓库。
