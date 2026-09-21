# LaMa GPU 替换与阻塞验证（2026-09-21）

本次将旧 NCNN AOT-GAN 抹字替换为 manga-image-translator 的 LaMa Large 漫画权重。Windows 的 GPU 路径为 ONNX Runtime DirectML，检测／日文 OCR 特征仍为 NCNN Vulkan。实际验证设备是 RX 6900 XT / Ryzen 7 5800X，Python 3.12.11、ORT DirectML 1.24.4、NCNN 1.0.20260526。代码与本地实验已完成，不代表已部署或注册新的线上引擎版本。

## 跨显卡 GPU 与 Vulkan

[DirectML 官方说明](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)支持 Windows 的 DirectX 12 显卡，包括 AMD、NVIDIA、Intel。当前只有 AMD 实机证据；其他品牌需要运行下述验收工具。DirectML 仍受支持，但处于维护阶段，微软将新功能转向 WinML。

LaMa 的 FFC 使用复数 FFT，不能把 `.ckpt` 换成 NCNN 文件就直接启用 Vulkan。实测当前 NCNN 的 FFT/RFFT/IRFFT/DFT 层均不存在，当前 PyTorch 也没有对应 Vulkan FFT 内核；这说明现成链路不可直接使用，不证明自定义 Vulkan 实现不可能。本次没有实现 LaMa Vulkan。

参考 [Carve 的 ONNX 导出思路](https://github.com/Carve-Photos/lama/blob/main/saicinpainting/training/modules/ffc.py)，将 FourierUnit 改写为实数分离 DFT 矩阵。其公开 ONNX 的高维 MatMul 在本机 DirectML 报错，因此这里独立实现四维 MatMul，保留原漫画模型权重。36 个 FourierUnit 统一使用固定 512×512 输入对应的 64×64 特征矩阵，FP32。运行依赖不含 Torch；构建才需要 Torch/ONNX。

模型来源、应用代码／权重各自的许可、源文件与权重摘要见 [THIRD_PARTY.md](../THIRD_PARTY.md)。本次构建的 ONNX SHA-256：`c8c5be1ffdbc953d9218c582bfcda988d37ecffdfea807e5a47795f68be73422`。启动校验 `build.json` 的架构／源权重／精度和实际 ONNX 摘要，参与引擎版本计算。

备选方案包括 [AOT-GAN](https://github.com/researchmm/AOT-GAN-for-Inpainting) 与 [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN)。前者是本项目替换前的 Vulkan 方案，后者面向轻量图像修复并提供 ONNX 导出。它们不是已有漫画样本上“效果等同 LaMa”的结论；本次没有做同掩码质量排名。当前已有可运行的 LaMa GPU 路径，因此保留 LaMa。

## 数值和图片

- 原 Torch FFT 与矩阵 DFT：种子 12 的固定输入，最大误差 `4.1723e-6`、平均 `1.0165e-7`；导出前强制检查。
- 最终 ONNX 同一输入的 DirectML / CPU：最大误差 `5.5432e-6`、平均 `9.6192e-8`，以 0–1 RGB 计。
- `session.disable_cpu_ep_fallback=1` 后仍成功；运行 profile 的计算节点只有 `DmlExecutionProvider`，没有 CPU 模型算子。预／后处理仍使用 CPU。
- 512×512 预热后 GPU 三次为 40.53 / 39.84 / 42.26 ms；同 ONNX CPU 两线程为 2578.35 / 2552.67 / 2534.01 ms。这是单模型调用，不是整页或网络吞吐。
- 裁剪保持比例，最大缩至 512，补边同步反射图像与掩码，避免未遮挡的文字复制到上下文；只合成原掩码覆盖像素。首次视觉复查发现此补边缺陷，已修正并加入回归测试。
- 自然漫画 626×900 单张重复测试，保存原图、掩码、抹字图、固定文本嵌字图；人工检查主要文字已经去除，个别区域仍有轻微残影，不能据此宣称所有纹理／艺术字达到无残留效果。24 次输出完全一致，掩码外改变像素为 0。
- 另有英文／日文生成样张，检查真实 OCR、抹字和交付。纯白气泡中文字的深色像素须减少超过 95%，而非仅验证文件可解码。实测英文 3283→0、日文 1606→0。

本地证据（不提交图片或模型）：`artifacts/lama-validation/gpu-parity/report.json`、`gpu-benchmark/report.json`、`gpu-benchmark/comparison.png`、`artifacts/v2-smoke/`。

## 整页性能

每档重复相同自然漫画 8 页；含解码、真实检测／OCR、LaMa、固定译文嵌字和编码。预热在计时外，无 LLM／R2 请求。不是 8 张不同漫画或生产端到端吞吐。

| 同时处理页数 | 8 页总耗时 | 吞吐 页/分钟 | 每页平均 / P95 | 进程峰值 RSS MiB | 平均 CPU 核数 |
|---|---:|---:|---:|---:|---:|
| 1 | 4.363 s | 110.02 | 0.526 / 0.582 s | 668.4 | 1.89 |
| 2 | 2.815 s | 170.50 | 0.667 / 0.852 s | 694.7 | 3.07 |
| 8 | 2.692 s | 178.31 | 2.239 / 2.667 s | 932.8 | 3.73 |

单页平均：解码 7.86 ms，检测/OCR 240.38 ms，抹字 219.80 ms，嵌字编码 57.46 ms。并发下模型锁等待计入抹字时间；按 DirectML 约束，同一个 session 的 Run 串行。`local_pages=2` 仍适合作为默认值：此样本升到 8 的吞吐增益有限，单页等待和内存上升。RSS 不包括独立 GPU 显存，本次没有记录显存峰值。

## 8 个执行位、4 个上传位与阻塞

`tools.validate_pipeline_pressure` 使用真实 Agent/Pipeline/Journal；中心、LLM 和网络为事件门控模拟。每场 24 页，8 个整页租约、4 个上传 worker、4 个下载 worker、1 GiB 页面缓冲预算。指定 `--models` 时运行真实 GPU 图像流程。

| 场景 | 阻塞期间检查 | 解锁结果 |
|---|---|---|
| 所有 LLM 等待 | 8 页已完成 OCR／抹字，释放计算任务，心跳继续，无提前嵌字 | 24 页全部交付 |
| 所有上传等待 | 4 个上传同时阻塞，8 页均已完成嵌字并释放图像缓冲 | 24 页全部交付 |
| 下载、分析提交、LLM、上传、完成回执各阻塞一页 | 5 页仍等待，其他 19 页跨多轮领取全部完成，心跳继续 | 最终 24 页全部交付 |

各场分析／上传／完成计数均为 24，无重复结算；结束时本地租约日志为空、页面预算占用归零。峰值页面预留 860602368 字节，小于 1 GiB；这是预算预留，不是进程 RSS。对应 CPU fixture 回归覆盖 `local_pages=1` 和 `8`。

后端真实控制器集成另覆盖 16 页分两轮：先 8 页阻塞 LLM，再 4 路上传阻塞；释放后下一批 8 页领取并完成。既有恢复、取消、重复完成、PUT 回执丢失等测试一并执行。

最终结果：引擎／节点测试 87 项通过；后端 compute-v2／节点集成 24 项通过（含两项真实 GPU 样张）；三场真实图像模型阻塞实验各 24 页全部通过。后端有两项既有 Starlette/AnyIO 弃用提示，没有测试失败。

执行位是包含文本等待／上传的整页租约：全部 8 位都阻塞时暂停新接单是有界背压。只有部分任务阻塞时，可用位和独立池才继续流动；不能保证在所有依赖永久阻塞时仍无限接单。网络门控未调用真实供应商，线上限流／断网恢复仍按现有协议处理，不属于本次线上验收。

## 复现

先按 [README](../README.md) 在新的隔离环境安装并构建模型，不修改运行中节点的虚拟环境。以下在 `services/classic-engine` 执行，`<sample.png>` 为本地授权样本；图片与掩码不提交：

```powershell
.\.venv-lama\Scripts\python -m pytest -q
.\.venv-lama\Scripts\python -m tools.benchmark_lama <sample.png> --output artifacts/lama-validation/gpu-benchmark
.\.venv-lama\Scripts\python -m tools.validate_lama_gpu artifacts/lama-validation/gpu-benchmark/source.png artifacts/lama-validation/gpu-benchmark/mask.png
.\.venv-lama\Scripts\python -m tools.validate_pipeline_pressure --models models --local-pages 8 --output artifacts/lama-validation/pressure-gpu.json
```

中心集成在仓库根目录运行（先将 `backend/requirements.txt` 装进同一个隔离测试环境）：

```powershell
$env:CLASSIC_TEST_MODELS = (Resolve-Path services/classic-engine/models).Path
services/classic-engine/.venv-lama/Scripts/python -m pytest backend/tests/test_compute_v2.py backend/tests/test_compute_node_v2.py -q
```

本次实际隔离环境路径为 `build-models/lama/.venv-gpu`。线上节点未重启，中心有效引擎版本未更改；本次不包含 Git 提交、推送、部署或真实 LLM/R2 调用。
