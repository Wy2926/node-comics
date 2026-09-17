# 漫画引擎性能优化与验收

2026-09-17，本地 Windows、i9-13980HX、RTX 4060 Laptop 8 GiB、PyTorch 2.5.1+cu124。实现与本地验证已完成，未重启业务节点、公开部署或重建 Linux 容器。原始报告／图片在被 Git 忽略的 `private-test-data/`；一次性诊断脚本已移出仓库，仅维护下文统一验收入口。

## 已采用的优化

| 模块 | 实现与边界 |
| --- | --- |
| [嵌字几何](../services/classic-engine/typesetter_geometry.py) | 前景裁剪、相同行合并、NumPy 柱状图边界计算；保持最大矩形与等面积选择。固定输入嵌字 3.617 → 0.701 秒，见[嵌字说明](LETTERING_LAYOUT.md) |
| [分格几何](../services/classic-engine/panel_geometry.py) | 移除 PNG 往返，批量筛选候选与切片构造多边形，保留 Kumiko 候选顺序；CPU／CUDA 都以单个独立 CPU 进程和检测／OCR 重叠，结束或失败均排空 |
| [XPOS 常量缓存](../services/classic-engine/ocr_position_cache.py) | 保留计算顺序，按设备、dtype、scale、长度和 offset 隔离；最多 32 MiB／2048 项，训练旁路、关闭释放，不保留图片／文字 |
| [掩膜几何](../services/classic-engine/mask_geometry.py) | 包围盒过滤无效求交，按需计算兜底距离；保留浮点分数、同分顺序、双边滤波与 CRF |
| [神经网络执行](../services/classic-engine/neural_acceleration.py) | FP32 OCR 批次内交叉注意力投影缓存与完成结果回传、LaMa 冻结计算图；本机选项 `portable-v1` 开启 |

没有新增依赖、权重或字体。固定源版本、SHA-256 和许可见 [analysis-sources.json](../services/classic-engine/third_party/analysis-sources.json) 与[排版来源记录](../services/classic-engine/third_party/manga-typesetter.json)。Docker 已包含新运行模块。

OCR 投影缓存按层最多一项，总上限 64 MiB（保守包含保留的输入和 K/V）；输入对象、修改版本或 offset 改变即失效，beam 收缩重新计算，超限正常计算。成功／失败均清空，禁止跨页复用，原 beam、XPOS、softmax 和颜色算法不变。样本峰值约 63 MiB，页结束为零；XPOS 常量容量另计。

LaMa-large 无 MPE 生成器使用 `trace`、`freeze(optimize_numerics=False)` 和 `optimized_execution(False)`，关闭逐尺寸优化编译，保持 FP32／FFT。接单前校验两个尺寸与非空掩膜；图不落盘、不按页构建，失败则启动失败，不切 CPU。一次构建／自检 CUDA 约 28 秒、CPU 约 3.9 秒，未计入稳态时延。

## 配置与 AMD 边界

`neural_acceleration` 为本机启动项，可选 `eager`（省略时默认）或 `portable-v1`；无配置文件时可用 `ENGINE_NEURAL_ACCELERATION`。[CUDA 示例](../services/classic-engine/engine.cuda.example.json)已开启，现有私有配置未改动。版本自动追加 `-torch-portable-v1`，控制服务应匹配此版本，避免不同执行方式共用译图缓存。`/health.neural_acceleration` 返回执行器、设备、图调用次数和缓存计量。

新增逻辑集中在 PyTorch 适配模块，不绑定 TensorRT 或自定义 CUDA 算子。后续 ROCm 可沿用 `torch.cuda`／`cuda:0`，证据已按 `torch.version.hip` 区分运行时；具体 AMD 硬件、操作系统、驱动和计算图仍需实机验收。[PyTorch 官方说明](https://docs.pytorch.org/docs/main/notes/hip.html)

Windows DirectML 保留已有路径，明确拒绝 `portable-v1`；NVIDIA 验证不代表 AMD 支持已完成。线程参数和设备锁见[节点配置](NODE_CONFIGURATION.md)。

## 实测结果

第一轮分格／掩膜／XPOS 优化保持原模型与检测分辨率：CUDA 分析 2.351 → 1.265 秒（基线复测 2.472 秒）；CPU 7.325 → 5.475 秒（复测 6.587 秒）。按设备分别比较，分析、LaMa 和最终图一致。

第二轮以下述第一轮优化后的实现为基线。原创 `samples/starlight-bookshop.png`（1024×1536），固定短译文，分析 → LaMa → 嵌字，每组预热一页、计时五页。函数直调，不含 HTTP／LLM／R2，剖析页另计。

| 方案 | 分析（含 OCR） | OCR | LaMa 裁剪调用 | 抹字总计 | 嵌字 | 整页 |
| --- | --- | --- | --- | --- | --- | --- |
| 基线，OpenCV 2 线程 | 1.172 s | 0.536 s | 0.335 s | 0.392 s | 0.659 s | 2.222 s |
| portable-v1，2 线程 | 1.147 s | 0.488 s | 0.275 s | 0.335 s | 0.688 s | 2.170 s |
| 基线，8 线程 | 1.052 s | 0.555 s | 0.344 s | 0.401 s | 0.701 s | 2.155 s |
| portable-v1，8 线程 | 1.008 s | 0.513 s | 0.276 s | 0.334 s | 0.687 s | 2.029 s |
| 基线收尾复测，2 线程 | 1.196 s | 0.536 s | 0.350 s | 0.410 s | 0.706 s | 2.313 s |

仅神经执行优化整页收益约 2–6%，LaMa 裁剪调用减少约 18–21%；结合本机 8 线程，整页减少约 9–12%。保留系统波动，不视为固定加速比。8 线程不是全局默认，多进程需重新分配 CPU 预算。

CPU 第二轮每组计时两页：整页 9.068 → 8.743 秒，基线复测 9.021 秒；分析 4.862 → 4.703 秒，复测 4.914 秒。输出一致，不代表最佳 CPU 配置。

历史 35 秒单图 HTTP 容量定位（第一轮后、未启用神经优化）：1／2／3 模型进程为 19.61／27.96／32.26 页／分钟，单页平均 3.06／4.29／5.58 秒，全设备显存峰值 2952／5073／7204 MiB。仅为短时实验；生产单设备锁未改动，不代表当前服务支持这些并发容量。

## 验证与剩余热点

- 第二轮原图各计时页的分析、掩膜、抹字图、布局和最终图一致。另用原图、768×1152 缩放图、1024×568 裁剪图与 640×480 空白图完成 24 个计时页对照，全部一致；同一原始内容不等于四套漫画质量验收。
- 多尺寸运行 PyTorch 活跃显存峰值约 1.33 GiB、保留池峰值约 1.95 GiB，不含桌面和其他进程，不能与全设备显存混比。
- 引擎测试：106 passed、1 skipped、11 subtests passed，覆盖几何／同分选择、掩膜、缓存边界／清理、CPU／CUDA 投影精确结果、图动态尺寸、训练旁路和配置校验。
- 真实模型 ASGI 检查通过：未授权 401、错误版本 409、分析／抹字／嵌字 200、阶段缓存复用、最终图与直接调用一致。进程内 HTTPX transport 验证服务入口，不是网络压测。
- 未采用：SDPA 和卷积／BN 融合无稳定整页收益；FP16／BF16 改变部分框和像素且未提速；全网络默认图优化首个真实页面约 103 秒。候选实现已移除，保留结论。
- 剖析中双边滤波约 0.38 秒，排版 `resize_regions_to_font_size` 约 0.60 秒（矩形边界搜索自身约 0.17 秒），OCR 解码器主机累计约 0.24 秒。嵌套剖析时间不能与正常计时相加。剩余主要为 CPU 图像处理／排版和自回归小算子提交。

## 统一复现入口

先按项目说明准备原生引擎、权重、字体和排版包。PowerShell、仓库根目录，输出目录必须不存在；脚本持正常物理设备锁，不调用 LLM、R2 或数据库。

```powershell
# eager → portable-v1 → eager 复测；--image 可重复传多个样本
services/classic-engine/.venv/Scripts/python.exe scripts/benchmark_neural.py --directory private-test-data/neural-repeat --repeat 5 --profile
# 单独对照本机 8 线程配置
services/classic-engine/.venv/Scripts/python.exe scripts/benchmark_neural.py --directory private-test-data/neural-8threads --repeat 5 --opencv-threads 8
# 从配置启动加速器并验证服务接口
services/classic-engine/.venv/Scripts/python.exe scripts/benchmark_neural.py --directory private-test-data/neural-service-repeat --repeat 1 --service-mode portable-v1
$env:PYTHONPATH = "$((Get-Location).Path)/engines/mit-native"
services/classic-engine/.venv/Scripts/python.exe -m pytest services/classic-engine -q
```

`--device cpu` 切 CPU；`--torch-threads`／`--opencv-threads` 控制线程。报告保存配置、输入哈希、逐页差异、时延、启动成本与显存，不写对白全文；图片留在输出目录。`--profile` 单独记录 cProfile 与 CUDA stream 区间（含提交／等待空隙，不是纯 kernel 时间）。

历史证据在本机 `private-test-data/`：`typesetter-geometry-20260917/`、`analysis-optimized-{cuda,cpu}-20260917/`、`cuda-capacity-optimized-20260917/`、`neural-accepted-20260917/`、`neural-shapes-20260917/`、`neural-cpu-20260917/`、`neural-service-contract-20260917/`。未采用候选报告为 `neural-probe2-20260917/`、`neural-graph-20260917/`；一次性脚本归档为 `performance-script-archive-20260917/`，不随 Git 分发。
