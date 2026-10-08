# MTU 计算节点

常规漫画翻译的 v3 图像计算节点。组装固定版本的 [Manga Translator UI](https://github.com/hgmzhn/manga-translator-ui) DBNet 检测与文字蒙版、MangaLens、LaMa Large 和 PyQt6 气泡适配嵌字；复用 [Manga-Overlay-Translator](https://github.com/Yuff1010/Manga-Overlay-Translator) 文字类别加权评分，逐段试读并分流到中／韩／英各自的 PP-OCRv5 模型和日文 Manga OCR。Paddle 等比缩放与批处理使用 [RapidOCR](https://github.com/RapidAI/RapidOCR)，段落合并与阅读顺序使用 [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) 原生分组。图像模型使用 CUDA；中心执行文本翻译，节点输出无损 WebP 覆盖层。实现边界与支持范围见 [ENGINE.md](ENGINE.md)。

## 开发运行

需要 Python 3.12、uv、NVIDIA 显卡及支持 CUDA 12.6 的驱动。Windows 和 Linux 均使用 PyTorch CUDA 与 ONNX Runtime CUDA。Linux 系统库由 [Dockerfile](../compute-node/linux/Dockerfile) 提供。

在本目录执行：

```powershell
uv sync --locked --extra test
.\.venv\Scripts\python.exe -m tools.prepare_mtu
.\.venv\Scripts\python.exe -m classic_node check --config node.local.json
.\.venv\Scripts\python.exe -m classic_node run --config node.local.json
```

先复制 [node.example.json](node.example.json) 为私有 `node.local.json`，填写中心 HTTPS 地址及独立节点身份。`prepare_mtu` 从校验缓存重新生成 `.assets/` 下的 `upstream`、`models`、`fonts`、`licenses`、`hyphenation` 目录，移除已停用资产；这些目录仅存放生成文件。`check` 校验资产、字体和 GPU 预热；`run` 才注册接单。运行时不下载资产。Linux 将 Python 路径改为 `.venv/bin/python`。

## 验证

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe -m tools.validate_mtu --input D:/samples/original --reference D:/samples/reference --output D:/samples/mtu
.\.venv\Scripts\python.exe -m tools.validate_mtu --input D:/samples/original --reference D:/samples/reference --output D:/samples/mtu --translations D:/samples/translations.en.json
```

首次保存识别检查点、清理图和耗时／GPU／RSS 指标。译文 JSON 结构为 `{"00001.webp":{"0":"English text"}}`，键必须覆盖该页所有识别段；第二次生成译图和三列对照。`--language ar` 可测试阿拉伯语，默认 `en`；`--keep-lang zh` 可复现仅处理中文段落的对照，必须在生成检查点与渲染时使用同一筛选条件。固定译文测试不调用文本供应商。输出必须在原图目录之外；样本和输出不提交仓库。

真实模型测试设置 `MTU_TEST_ASSETS` 为准备目录后运行 `tests/test_mtu_integration.py`。中心联调使用同时安装后端依赖的环境运行 `backend/tests/test_compute_v3.py` 和 `backend/tests/test_compute_node_v3.py`；设置 `CLASSIC_TEST_MODELS` 可启用其中的真实 CUDA 用例。额外设置 `CLASSIC_TEST_INPUT` 为私有中文漫画图片，可验证阿拉伯语固定译文经真实节点上传覆盖图；图片留在仓库之外。模拟中心、真实模型效果、发布包和生产连接分别验收。

长图新旧版本对照可运行 `python -m tools.benchmark_pages --input D:/samples/original --output D:/samples/bench.json --models .assets/models --concurrency 2`。在各自可信源码和重新准备的资产目录中，用相同依赖、样本、线程、渲染进程与缓存预算运行；每种图预热后默认测量三轮。报告记录阶段耗时、进程树 RSS、PyTorch 分配／保留显存峰值与检查点／输出哈希；PyTorch 指标不包含 ONNX 等全部 GPU 占用。若测试 GPU 需要另一套 CUDA 包，两版必须使用同一套兼容环境，结果不能直接视为生产 GPU／锁定环境验收。固定英文长短文本只验证图像处理，不代表供应商翻译质量或线上端到端延迟。`--cache-mib` 是对照实验的每页预算，不是节点的固定缓存配置；生产仍由 `resident_bytes` 动态分配。整批墙钟包含读图和结果哈希检查，图像阶段耗时单独记录。输出报告不覆盖已有文件。

增加 `--pipeline --resident-mib 8192 --total 12` 可运行真实八租约调度器和内存门控，逐轮循环输入目录内的长短图；页缓冲、IPC、缓存预算和本地回退均由调度器决定，不使用 `--cache-mib` 固定逐页额度。中心、文本和存储仍为本地模拟，报告包含每页阶段／排队耗时、缓存需求／分配／命中／重算及交付次数校验。`--auto-cpu` 验证当前启动资源规划器，手工线程／进程参数用于同资源 A/B。

分析细分记录检测、分组、路由、OCR、取色、气泡、蒙版细化和检查点耗时；抹字细分准备、纯色填充、LaMa。锁等待包含在对应阶段内，不可重复相加。仅原有时间字段送中心，细分指标及字节／次数计数留在本地测量，不扩展协议、不记录私有文本。大图提前分块时 `render_encode` 是分块差分、编码、校验及组包的总墙钟时间，`render_diff` 仅为分块前规划；比较输出开销应使用二者之和。`render_tile_diff_sum`／`render_tile_encode_sum` 是并发任务耗时之和，不是墙钟时间。

取色额外记录 `analyze_color_gate` 检查耗时、`color_fast_regions`／`color_fast_lines` 无明显彩色而直接使用默认配色的段／行数和 `color_model_lines` 实际模型输入行数；前者包含在 `analyze_colors` 内。每段最大有效行取色和默认黑字白边会改变配色，包括不保留灰字、反白字原样式，须比较原图与新旧输出，不能只验收耗时或要求旧版逐像素相等；完整 OCR、抹字与排版几何仍需保持。具体规则见 [ENGINE.md](ENGINE.md#排版配置)。

## 部署与协议

- [Windows 独立节点包](../compute-node/README.md)、[Linux NVIDIA](../compute-node/linux/README.md)
- [节点配置](../../docs/NODE_CONFIGURATION.md)、[运行与恢复](docs/NODE_OPERATIONS.md)
- [v3 计算协议](../../docs/COMPUTE_PROTOCOL.md)、[第三方来源](THIRD_PARTY.md)

结果继续使用稀疏无损 WebP，已协商的超长页面使用分块包。二值覆盖 alpha 和 `source-atop` 保留原图透明度；SQLite 原子冻结结果与完成记录，终态回执后清除。MTU 迁移必须先排空旧节点，再以新配置启动；旧图像检查点不能交给新引擎继续绘制。
