# Manhua Engine

轻量漫画翻译流水线，参考 [manga-image-translator](https://github.com/zyddnys/manga-image-translator) 和 [Yakuyomi Engine](https://github.com/joyeli/yakuyomi-engine)。检测使用 NCNN Vulkan FP32，局部去字使用 ONNX Runtime GPU FP32 LaMa Large（Windows DirectML、Linux NVIDIA CUDA）；默认多语言 OCR，按目标语言嵌字。安装与 Linux GPU 环境见 [节点说明](README.md)。Windows 不需要 CUDA。

## 支持范围

| 来源 / `--ocr-language` | 识别方案 | 默认嵌字方向 |
|---|---|---|
| 自动 `auto`（默认） | MIT 文字脚本／颜色探针 → PP-OCRv6 small（简繁中、日、英）或 PP-OCRv5 Korean；两个识别器均为 ONNX CPU FP32 | CJK 目标沿用原区域横 / 竖排，其他目标横排 |
| 对照 `ja` | MIT 多语言 48px CTC：Vulkan 特征 + ONNX CPU 解码；使用上游原字表，`ja` 并非日文专用权重 | CJK 目标沿用原区域横 / 竖排，其他目标横排 |
| 韩文 `ko` | RapidOCR PP-OCRv5 Korean mobile，ONNX CPU FP32 | 韩文目标横排 |
| 英文 `en` | RapidOCR PP-OCRv5 English mobile，ONNX CPU FP32 | 英文目标横排、单词换行、离线断词 |
| 中文 `zh` | RapidOCR PP-OCRv5 Chinese mobile，中英日混合字表 | 中文目标沿用原区域横 / 竖排 |
| 拉丁文字 `latin` | RapidOCR PP-OCRv5 Latin mobile | 横排；带重音字符不拆散 |

`--ocr-language auto` 无需输入来源语言；`--source` 仅作为 CLI 文本翻译提示，默认 Auto。自动模式一次加载 MIT 探针、PP-OCRv6 small 和韩文 PP-OCRv5。每行先读取探针原始结果：置信度至少 0.30、存在韩文字母且其占字母字符的比例至少 25% 时选择韩文模型，其余选择 small；不根据目标语言选择 OCR。低于最终 0.50 过滤阈值的探针文字仍可用于分流，最终识别以所选模型置信度过滤，文字颜色沿用探针结果。自动模式按区域文字类型拼接英文、韩文和 CJK 行，不修改漫画默认从右到左的区域顺序。显式 `ja/zh/en/ko/latin` 用于模型对照与专项处理，只加载所选识别器。

MIT 探针／`ja` 权重来自上游 `beta-0.3/ocr-ctc.zip`（SHA-256 `fc61c52f7a811bc72c54f6be85df814c6b60f63585175db27cb94a08e0c30101`），原模型代码固定于 `d5a3eee4a7b7b7754b71baa2ee82309dfff468bc`，原 `alphabet-all-v5.txt` 字表转换时逐项核对；导出为 FP32 NCNN backbone + ONNX decoder。small 和韩文权重、字典、版本及摘要见 `manhua_engine/models.json`，来源许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。模型字表支持不等于所有艺术字、手写字或语言组合均准确。

采用 uniseg 的 Unicode 换行 / 字素规则、Pyphen 自带离线词典、fontTools 字体覆盖检查和 Pillow/FreeType 绘制。英文不会逐字符强拆，CJK 标点遵循换行约束；保留显式换行、组合重音、韩文音节和字体回退。不支持的字符先按固定表替换（例如 `❤` → `♥`），仍不支持则移除；整段移空时跳过该段嵌字，保留抹字结果并继续其他段。只调整绘制文本，不修改中心译文。字体覆盖表有界缓存，每段在字号试探前清理一次。`--direction horizontal/vertical` 可覆盖默认方向。

长宽比超过 2.5 的长条漫画自动重叠分段检测、合并掩膜和去重，保留文字分辨率。每个识别器最多进行一次低置信度重裁剪，自动模式的尝试数包含探针与所选识别器；局部修复保持图像比例，最终只修改去字掩膜与文字区域。

LaMa 推理掩膜与最终回填掩膜独立：给模型的未知区域额外扩展 5 个原图像素，减轻紧贴文字形状导致的笔画残影；实际写入仍限于原去字掩膜。

## 安装与模型

```powershell
$env:UV_PROJECT_ENVIRONMENT = '.venv-lama'
uv sync --locked --extra test --extra build
.\.venv-lama\Scripts\python -m manhua_engine.cli download --ocr-language all
.\.venv-lama\Scripts\python -m tools.build_lama --models models
.\.venv-lama\Scripts\python -m manhua_engine.cli devices
```

也可只下载所需模型，如 `download --ocr-language auto` 会准备 small 权重、配套 YAML 字典和韩文模型；现有节点升级自动模式也需补齐这三个文件。MIT 转换模型仍需保留。`download --ocr-language ko` 只准备韩文识别及通用模型。模型清单随包分发，支持从其他工作目录调用；下载和节点身份检查都校验 SHA-256。运行时不会下载模型或断词词典。Windows 自动选择 Arial / 微软雅黑 / 游ゴシック / Malgun Gothic；Linux 安装 Noto Sans CJK 或用可重复的 `--font /path/font.otf` 指定字体。

MIT OCR 与 LaMa 的完整构建使用 [Windows 节点构建入口](../compute-node/README.md#开发构建与验证)或 [Linux NVIDIA 镜像构建](../compute-node/linux/README.md#构建)。两者复用转换器和锁文件，自动下载固定源码与检查点，分别创建锁定的 OCR 和 LaMa 转换环境，不依赖本机已有的 `models/` 或 `.venv-build`。构建不要求 Git 克隆上游完整应用；OCR 所需模型源码单文件以固定提交 URL 和 SHA-256 校验。

转换器 `tools/build_ocr.py` 由构建入口传入已校验的 `--source-file`、`--archive`、`--work` 和 `--output`。它校验检查点和字典；运行只需要 `ocr-fp32/backbone.ncnn.param/bin` 和 `decoder.onnx`。构建工作目录另保留 `ocr.onnx` 与 `build.json` 供数值验证。实际推理始终关闭 FP16。

## 使用

```powershell
# 日文漫画嵌入英文：即使原文竖排，英文仍按单词横排
.\.venv-lama\Scripts\python -m manhua_engine.cli run 'D:/漫画/日文' `
  --source Japanese --target English --translation online --output artifacts/english

# 韩文识别与日文嵌字；设置主要 OCR 语言也适用于包含英文的韩漫
.\.venv-lama\Scripts\python -m manhua_engine.cli run 'D:/漫画/韩文' `
  --source Korean --target Japanese --translation online --output artifacts/japanese

# 英文识别与韩文嵌字
.\.venv-lama\Scripts\python -m manhua_engine.cli run 'D:/漫画/英文' `
  --source English --target Korean --translation online --output artifacts/korean
```

在线首次请求前，在当前终端设置 `OPENAI_API_KEY`。用 `--base-url` 和 `--model` 指定兼容 Chat Completions 的服务与模型。默认沿用本地项目的接口与模型配置。相同参数再次运行可改为 `--translation offline`；缺缓存直接报错。在线模式也先读缓存，超时不自动重试，避免重复计费。空白页不请求翻译；错误、缺编号、截断结果不会缓存。

`--glossary terms.json` 接受非空字符串的来源词到目标词映射，例如 `{"明日香":"Asuka"}`，用于统一人名和术语。术语表、完整提示词、来源 / 目标语言、模型、接口和有序原文均参与缓存键，修改任一项就需要新翻译。默认无术语表时仍可复用原缓存。

输出包含 PNG、逐页 JSON 和 `report.json`。JSON 记录检测框、OCR 原文 / 置信度 / 尝试数、翻译、实际排版方向 / 分行 / 字体 / 范围和阶段耗时。源图不覆盖；同名输出冲突会拒绝。

横排嵌字会在擦字后的页面上寻找气泡内部空白，按每行实际可用宽度平衡完整单词，不再受中文竖排窄框限制。轮廓留边距，同一气泡内的多个文本块分区，避开画面和相邻原文框。无法可靠识别气泡、明显旋转文字、显式换行与中日文竖排保留原文字框排版。JSON 中 `layout.area_source` 区分 `bubble` / `text`，`area_bbox` 记录气泡排版范围；OCR 框与擦字范围保持原始几何。

长段落沿用 Pillow/FreeType，不依赖 Qt。字体对象按线程缓存，完整字串度量与字形栅格分层复用；有描边且边界已覆盖末尾字距时，不重复测量最后字体段的 advance，字体回退衔接仍保留精确字距。矩形排版超过高度预算即停止试排；气泡断行按需测量候选并缓存行带，只按非负评分下界剪枝，不缩减译文或改用逐字宽度估算。候选度量缓存上限 8192、行带缓存上限 1024，限于一次字号探测，结束后释放。

## 性能与验证

- `--pages 1` 优先单页延迟，默认 `2` 重叠页间工作；更高并发不保证更快。
- `--ocr-workers 8` 是全局 OCR 池，ORT 每次只用一个内部线程。自动模式的 MIT Vulkan 探针特征串行、CPU 解码和所选 PP-OCR 推理可并行；同一行不同时运行 small 和韩文识别器。三个模型常驻并在接单前全部预热。额外识别会增加 CPU 耗时与内存，应按目标机器验证并发吞吐。
- `--threads 2` 控制 CPU 算子线程数；LaMa 同一 DirectML session 的 Run 串行，网络和其他阶段可以并发；`--detect-size 1280` 可选 1024 / 1536 / 2048。
- `--tile 768` 是局部去字上限，当前 LaMa ONNX 进一步限制为 512，并保持裁剪比例；`--png-compression 1` 默认快速无损输出。
- `--gpu -1` 显式使用 CPU。模型只加载一次，字体覆盖与网络预热在计时前完成。

```powershell
.\.venv-lama\Scripts\python -m pytest -q
.\.venv-lama\Scripts\python tools/validate_multilingual.py
.\.venv-lama\Scripts\python tools/benchmark.py 'D:/test-comics/source' `
  --source 'Japanese and Chinese (mixed; preserve existing Chinese)' `
  --configs '1:8,2:8' --output artifacts/benchmark
.\.venv-lama\Scripts\python tools/validate_quality.py 'D:/test-comics/source' artifacts/benchmark/d2-w8
.\.venv-lama\Scripts\python tools/probe_ocr.py 'D:/test-comics/source' --limit 24 --output artifacts/ocr-probe-new
```

效果检查应覆盖 OCR 漏字、背景残影、缺字、换行、气泡边界和画面保持。生成样张与固定译文验证图像阶段，在线文本质量使用真实样本单独评估；性能须记录设备、引擎版本和阶段耗时。

## 目录

`manhua_engine/` 只保留运行代码、字表和模型清单；`vendor/` 保留有出处的分组 / CTC / 几何算法。`tools/` 放构建、基准、质量与可视化工具，`tests/` 放离线回归。

`models/` 放可加载权重及验证参考，`build-models/` 放上游源码、检查点与中间产物；`cache/` 和 `artifacts/` 保存本地缓存与输出。原图、缓存、模型和生成样张均不提交 Git。

GPL-3.0；具体上游版本和依赖许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。
