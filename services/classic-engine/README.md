# MTU 计算节点

常规漫画翻译的 v3 图像计算节点。组装固定版本的 [Manga Translator UI](https://github.com/hgmzhn/manga-translator-ui) DBNet 检测与文字蒙版、MangaLens、LaMa Large 和 PyQt6 气泡适配嵌字；复用 [Manga-Overlay-Translator](https://github.com/Yuff1010/Manga-Overlay-Translator) 文字类别加权评分，逐段试读并分流到中／韩／英各自的 PP-OCRv5 模型和日文 Manga OCR。Paddle 等比缩放与批处理使用 [RapidOCR](https://github.com/RapidAI/RapidOCR)，段落合并与阅读顺序使用 [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) 原生分组。图像模型使用 CUDA；中心执行文本翻译，节点输出无损 WebP 覆盖层。实现边界与支持范围见 [ENGINE.md](ENGINE.md)。

## 开发运行

默认需要 Python 3.12、uv、NVIDIA 显卡及支持 CUDA 12.6 的驱动。Windows 和 Linux 默认使用 PyTorch CUDA 与 ONNX Runtime CUDA；不自动探测切换后端。Linux 系统库由 [Dockerfile](../compute-node/linux/Dockerfile) 提供。

在本目录执行：

```powershell
uv sync --locked --extra test
.\.venv\Scripts\python.exe -m tools.prepare_mtu
.\.venv\Scripts\python.exe -m classic_node check --config node.local.json
.\.venv\Scripts\python.exe -m classic_node run --config node.local.json
```

先复制 [node.example.json](node.example.json) 为私有 `node.local.json`，填写中心 HTTPS 地址及独立节点身份。`prepare_mtu` 从校验缓存重新生成 `.assets/` 下的 `upstream`、`models`、`fonts`、`licenses`、`hyphenation` 目录，移除已停用资产；这些目录仅存放生成文件。`check` 校验资产、字体和 GPU 预热；`run` 才注册接单。运行时不下载资产。Linux 将 Python 路径改为 `.venv/bin/python`。

### 可选 AMD 环境（Windows / RX 6900 XT）

仅显式配置 `engine.backend: "amd"` 启用；未配置或设为 `"cuda"` 均保持 NVIDIA 路径。当前 AMD 组合为 TheRock/ROCm PyTorch HIP 与 PP-OCR DirectML，限定单 GPU、设备 0 的 Windows x64 主机；HIP 与 DirectML 的设备 0 必须为同一张 Radeon。其他架构、多显卡／混合显卡和 AMD Linux 未验收。PyTorch HIP 沿用其原生 `torch.cuda` API，不使用 ZLUDA、不改驱动或系统 PATH。实现边界见 [ENGINE.md](ENGINE.md#可选后端)。

从本目录运行以下命令；[独立项目](environments/amd/pyproject.toml)复用公共依赖声明，但使用自己的 `uv.lock` 和 `environments/amd/.venv`，不向默认 `.venv` 安装 AMD 包。清除外部 `UV_PROJECT_ENVIRONMENT` 覆盖，不使用 `--active`，不混装三种 ONNX Runtime 分发包。

```powershell
uv sync --project environments/amd --locked --group test
uv run --project environments/amd --locked python -m tools.prepare_mtu --output D:/amd-node/assets --cache D:/amd-node/downloads
uv run --project environments/amd --locked python -m classic_node check --config D:/amd-node/node.local.json
```

资产仍用 `tools.prepare_mtu`，为 AMD 指定独立输出目录，并将私有配置的 `engine.models`、`engine.font` 指向该目录；设置 `engine.backend: "amd"`、`engine.gpu: 0` 和独立 `state_dir`。不要复用正在接单的节点身份、状态或资产准备目录。`check` 只做本地校验和预热；只有明确授权接入中心后才运行 `run`。现有 Windows 发布包和 Linux NVIDIA 构建仍使用根 CUDA 锁文件，不包含此 AMD 环境。

AMD 验证沿用下列工具，用该环境的 Python 并增加 `--backend amd`；真实模型测试另外设置 `MTU_TEST_BACKEND=amd`。2 万／5 万像素图应先单页测量再增加并发；不能因使用相同并发参数便推断与 RTX 5060 容量或性能相同。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m tools.validate_mtu --input D:/samples/original --reference D:/samples/reference --output D:/samples/mtu
.\.venv\Scripts\python.exe -m tools.validate_mtu --input D:/samples/original --reference D:/samples/reference --output D:/samples/mtu --translations D:/samples/translations.en.json
```

首次保存识别检查点、清理图和耗时／GPU／RSS 指标。译文 JSON 结构为 `{"00001.webp":{"0":"English text"}}`，键必须覆盖该页所有识别段；第二次生成译图和三列对照。`--language ar` 可测试阿拉伯语，默认 `en`；`--keep-lang zh` 可复现仅处理中文段落的对照，必须在生成检查点与渲染时使用同一筛选条件。固定译文测试不调用文本供应商。输出必须在原图目录之外；样本和输出不提交仓库。

真实模型测试设置 `MTU_TEST_ASSETS` 为准备目录后运行 `tests/test_mtu_integration.py`。中心联调使用同时安装后端依赖的环境运行 `backend/tests/test_compute_v3.py` 和 `backend/tests/test_compute_node_v3.py`；设置 `CLASSIC_TEST_MODELS` 可启用其中的真实 CUDA 用例。额外设置 `CLASSIC_TEST_INPUT` 为私有中文漫画图片，可验证阿拉伯语固定译文经真实节点上传覆盖图；图片留在仓库之外。模拟中心、真实模型效果、发布包和生产连接分别验收。

长图性能检查可运行 `python -m tools.benchmark_pages --input D:/samples/original --output D:/samples/bench.json --models .assets/models --concurrency 2`。对比实现时，在各自可信源码和重新准备的资产目录中，用相同依赖、样本、线程、渲染进程与缓存预算运行；每种图预热后默认测量三轮。报告记录阶段耗时、进程树 RSS、PyTorch 分配／保留显存峰值与检查点／输出哈希；PyTorch 指标不包含 ONNX 等全部 GPU 占用。测试 GPU 若使用非锁定 CUDA 环境，结果不能直接视为生产 GPU／锁定环境验收。固定英文长短文本只验证图像处理，不代表供应商翻译质量或线上端到端延迟。`--cache-mib` 是对照实验的每页预算，不是节点的固定缓存配置；生产由 `resident_bytes` 动态分配。整批墙钟包含读图和结果哈希检查，图像阶段耗时单独记录。输出报告不覆盖已有文件。

增加 `--pipeline --resident-mib 8192 --total 12` 可运行真实八租约调度器和内存门控，逐轮循环输入目录内的长短图；页缓冲、IPC、缓存预算和本地回退均由调度器决定，不使用 `--cache-mib` 固定逐页额度。中心、文本和存储仍为本地模拟，报告包含每页阶段／排队耗时、缓存需求／分配／命中／重算及交付次数校验。`--auto-cpu` 验证当前启动资源规划器，手工线程／进程参数用于同资源 A/B。

批量／显存策略对照沿用该工具：`--ocr-batch-size 4 --ocr-min-batch-size 1 --color-batch-size 4 --detect-batch-size 4`，并用 `--ocr-arena-extend-strategy kNextPowerOfTwo --no-ocr-arena-shrinkage --ocr-min-batch-size 4` 对照旧显存策略；只比较失败恢复时保持相同 arena 设置，仅把 `--ocr-min-batch-size` 改为 4 禁用缩批。报告保存实际推理参数；两组须在同一空闲测试 GPU、相同样本与页并发下分别启动，不能对在线接单进程运行压测。`--concurrency` 支持 1–8，4 页场景也可测量。`--pipeline` 复用工具已有的阶段观测包装，将完整数值诊断写入报告 JSON；生产不新增逐阶段详细日志或 GPU 资源查询，记录边界见[节点运维](docs/NODE_OPERATIONS.md#状态与恢复)。仅隔离容量实验可用 `--reserve-vram-mib` 预留测试显存，报告明确记录这部分占用；这不是全局显存限制，也不能将 12 GiB 卡预留 4 GiB 的结果当作 8 GiB 目标卡验收。

分析细分记录检测、分组、路由、OCR、取色、气泡、蒙版细化和检查点耗时；抹字细分准备、纯色填充、LaMa。锁等待包含在对应阶段内，不可重复相加。仅原有时间字段送中心，细分指标及字节／次数计数留在本地测量，不扩展协议、不记录私有文本。大图提前分块时 `render_encode` 是分块差分、编码、校验及组包的总墙钟时间，`render_diff` 仅为分块前规划；比较输出开销应使用二者之和。`render_tile_diff_sum`／`render_tile_encode_sum` 是并发任务耗时之和，不是墙钟时间。

取色记录 `analyze_color_gate` 检查耗时、`color_fast_regions`／`color_fast_lines` 无明显彩色而直接使用默认配色的段／行数和 `color_model_lines` 实际模型输入行数；前者包含在 `analyze_colors` 内。每段最大有效行取色和默认黑字白边不保留灰字、反白字原样式，须比较原图与输出，不能只验收耗时；完整 OCR、抹字与排版几何仍需保持。具体规则见 [ENGINE.md](ENGINE.md#排版配置)。

## 部署与协议

- [Windows 独立节点包](../compute-node/README.md)、[Linux NVIDIA](../compute-node/linux/README.md)
- [节点配置](../../docs/NODE_CONFIGURATION.md)、[运行与恢复](docs/NODE_OPERATIONS.md)
- [v3 计算协议](../../docs/COMPUTE_PROTOCOL.md)、[第三方来源](THIRD_PARTY.md)

结果使用稀疏无损 WebP，已协商的超长页面使用分块包。二值覆盖 alpha 和 `source-atop` 保留原图透明度；SQLite 原子冻结结果与完成记录，终态回执后清除。检查点兼容与升级要求见[运行与恢复](docs/NODE_OPERATIONS.md#升级与验收)。

通过 Linux Landlock ABI ≥3 与 libseccomp 沙箱启动探测的节点声明 `document_protocol:2`，支持[文件页协议](../../docs/COMPUTE_PROTOCOL.md#文件页协议)，不依赖用户命名空间或特权容器；无此能力的 Windows／Linux 宿主仍可接普通 v3 单图。后台 `document_slots` 为保守并发，低优先级领取和闲时借位遵循[文件调度规则](../../docs/DOCUMENT_TRANSLATION.md#共享调度与闲时借位)，复用同一模型、固定执行池与内存预算。原文件只下载一次，规范化页、分析与译图保存在私有 `state/documents/{job}/{generation}`，OCR 仅回传文本后释放租约，最终 ZIP 一次流式上传 R2。中央负责唯一 LLM 调用和额度，不向节点下发 LLM／R2 密钥。工作目录须持久化并设置磁盘硬配额，同机重启可续跑，丢盘后不自动重发已发送 LLM。升级前排空旧文件任务并迁移 0018，不与旧 v1 混跑。
