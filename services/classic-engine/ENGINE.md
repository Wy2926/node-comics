# Manhua Engine

轻量漫画翻译流水线，参考 [manga-image-translator](https://github.com/zyddnys/manga-image-translator) 和 [Yakuyomi Engine](https://github.com/joyeli/yakuyomi-engine)。检测使用 NCNN Vulkan FP32，局部去字使用 ONNX Runtime DirectML GPU FP32 LaMa Large；按来源语言选择 OCR，按目标语言嵌字。安装方式优先见 [节点说明](README.md)，无需 CUDA 或 Android SDK。

## 支持范围

| 来源 / `--ocr-language` | 识别方案 | 默认嵌字方向 |
|---|---|---|
| 日文 `ja` | MIT 48px CTC：Vulkan 特征 + ONNX CPU 解码；保留中英混合识别 | 日文目标沿用原区域横 / 竖排 |
| 韩文 `ko` | RapidOCR PP-OCRv5 Korean mobile，ONNX CPU FP32 | 韩文目标横排 |
| 英文 `en` | RapidOCR PP-OCRv5 English mobile，ONNX CPU FP32 | 英文目标横排、单词换行、离线断词 |
| 中文 `zh` | RapidOCR PP-OCRv5 Chinese mobile，中英日混合字表 | 中文目标沿用原区域横 / 竖排 |
| 拉丁文字 `latin` | RapidOCR PP-OCRv5 Latin mobile | 横排；带重音字符不拆散 |

`--ocr-language auto` 根据 `--source` 选择，默认来源是 Japanese。识别模型一次只加载一种，不逐行盲跑所有语言模型。混合漫画应指定主要语言；韩英混合选 `ko`，中英日横排混合可选 `zh`。日韩竖排漫画优先 `ja`。模型字表支持不等于所有艺术字、手写字或语言组合均准确。

采用 uniseg 的 Unicode 换行 / 字素规则、Pyphen 自带离线词典、fontTools 字体覆盖检查和 Pillow/FreeType 绘制。英文不会逐字符强拆，CJK 标点遵循换行约束；保留显式换行、组合重音、韩文音节和字体回退。无字体覆盖时明确报错，避免静默嵌入方框。`--direction horizontal/vertical` 可覆盖默认方向。

长宽比超过 2.5 的长条漫画自动重叠分段检测、合并掩膜和去重，保留文字分辨率。每条 OCR 最多进行一次低置信度重裁剪；局部修复保持图像比例，最终只修改去字掩膜与文字区域。

## 安装与模型

```powershell
$env:UV_PROJECT_ENVIRONMENT = '.venv-lama'
uv sync --locked --extra test --extra build
.\.venv-lama\Scripts\python -m manhua_engine.cli download --ocr-language all
.\.venv-lama\Scripts\python -m tools.build_lama --models models
.\.venv-lama\Scripts\python -m manhua_engine.cli devices
```

也可只下载所需模型，如 `download --ocr-language ko`。模型清单随包分发，支持从其他工作目录调用；下载时校验 SHA-256。运行时不会下载模型或断词词典。Windows 自动选择 Arial / 微软雅黑 / 游ゴシック / Malgun Gothic；Linux 安装 Noto Sans CJK 或用可重复的 `--font /path/font.otf` 指定字体。

日文 MIT OCR 首次使用需构建（本机已有构建产物）。独立构建环境：

```powershell
python -m venv .venv-build
.\.venv-build\Scripts\python -m pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu
.\.venv-build\Scripts\python -m pip install pnnx==20260526 onnx==1.17.0 einops opencv-python
git clone https://github.com/zyddnys/manga-image-translator.git build-models/mit
git -C build-models/mit checkout d5a3eee4a7b7b7754b71baa2ee82309dfff468bc
.\.venv-build\Scripts\python tools/build_ocr.py
```

构建校验源码提交、检查点和字典；临时导出文件在构建目录中自动清理。运行只需要 `ocr-fp32/backbone.ncnn.param/bin` 和 `decoder.onnx`；保留 `ocr.onnx` 与 `build.json` 供数值验证。实际推理始终关闭 FP16。

## 使用

```powershell
# 日文漫画嵌入英文：即使原文竖排，英文仍按单词横排
.\.venv\Scripts\python -m manhua_engine.cli run 'D:/漫画/日文' `
  --source Japanese --target English --translation online --output artifacts/english

# 韩文识别与日文嵌字；设置主要 OCR 语言也适用于包含英文的韩漫
.\.venv\Scripts\python -m manhua_engine.cli run 'D:/漫画/韩文' `
  --source Korean --target Japanese --translation online --output artifacts/japanese

# 英文识别与韩文嵌字
.\.venv\Scripts\python -m manhua_engine.cli run 'D:/漫画/英文' `
  --source English --target Korean --translation online --output artifacts/korean
```

在线首次请求前，在当前终端设置 `OPENAI_API_KEY`。用 `--base-url` 和 `--model` 指定兼容 Chat Completions 的服务与模型。默认沿用本地项目的接口与模型配置。相同参数再次运行可改为 `--translation offline`；缺缓存直接报错。在线模式也先读缓存，超时不自动重试，避免重复计费。空白页不请求翻译；错误、缺编号、截断结果不会缓存。

`--glossary terms.json` 接受非空字符串的来源词到目标词映射，例如 `{"明日香":"Asuka"}`，用于统一人名和术语。术语表、完整提示词、来源 / 目标语言、模型、接口和有序原文均参与缓存键，修改任一项就需要新翻译。默认无术语表时仍可复用原缓存。

输出包含 PNG、逐页 JSON 和 `report.json`。JSON 记录检测框、OCR 原文 / 置信度 / 尝试数、翻译、实际排版方向 / 分行 / 字体 / 范围和阶段耗时。源图不覆盖；同名输出冲突会拒绝。

横排嵌字会在擦字后的页面上寻找气泡内部空白，按每行实际可用宽度平衡完整单词，不再受中文竖排窄框限制。轮廓留边距，同一气泡内的多个文本块分区，避开画面和相邻原文框。无法可靠识别气泡、明显旋转文字、显式换行与中日文竖排保留原文字框排版。JSON 中 `layout.area_source` 区分 `bubble` / `text`，`area_bbox` 记录气泡排版范围；OCR 框与擦字范围保持原始几何。

## 性能与验证

- `--pages 1` 优先单页延迟，默认 `2` 重叠页间工作；更高并发不保证更快。
- `--ocr-workers 8` 是全局 OCR 池，ORT 每次只用一个内部线程。日文 Vulkan 特征串行、CPU 解码并行；其他语言仅加载所选 PP-OCR 模型。
- `--threads 2` 控制 CPU 算子线程数；LaMa 同一 DirectML session 的 Run 串行，网络和其他阶段可以并发；`--detect-size 1280` 可选 1024 / 1536 / 2048。
- `--tile 768` 是局部去字上限，当前 LaMa ONNX 进一步限制为 512，并保持裁剪比例；`--png-compression 1` 默认快速无损输出。
- `--gpu -1` 显式使用 CPU。模型只加载一次，字体覆盖与网络预热在计时前完成。

以下是 **2026-09-19 的 AOT 历史测量，不适用于当前 LaMa**。当前性能见 [LaMa 验证](docs/LAMA_VALIDATION.md)。本机 Windows / RX 6900 XT / Ryzen 7 5800X：40 页最终双页测量约 131.2 页/分钟，单页平均约 0.522 秒；后续排版对照中新版约 134.8 页/分钟。改造前为 138.1 页/分钟；同机后台负载变化明显，尚不能保证完全无回退。NVIDIA / Linux 未实机验收。准确率、性能口径和限制见 [质量验证](docs/QUALITY.md)。

```powershell
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python tools/validate_multilingual.py
.\.venv\Scripts\python tools/benchmark.py '0001-第01話-修订1' `
  --source 'Japanese and Chinese (mixed; preserve existing Chinese)' `
  --configs '1:8,2:8' --output artifacts/benchmark
.\.venv\Scripts\python tools/validate_quality.py '0001-第01話-修订1' artifacts/benchmark/d2-w8
.\.venv\Scripts\python tools/probe_ocr.py '0001-第01話-修订1' --limit 24 --output artifacts/ocr-probe-new
```

测试集主要为已有中文漫画，基准使用历史翻译缓存，不代表日韩英自然漫画的准确率。多语言生成样张验证真实识别模型和固定测试译文嵌字，不评估在线翻译质量。复杂艺术字、音效、弯曲文字和极窄气泡仍需人工检查；无法完整嵌字时会报错，不静默截断。

## 目录

`manhua_engine/` 只保留运行代码、字表和模型清单；`vendor/` 保留有出处的分组 / CTC / 几何算法。`tools/` 放构建、基准、质量与可视化工具，`tests/` 放离线回归，`docs/QUALITY.md` 统一验收记录。

`models/` 放可加载权重及验证参考，`build-models/` 放上游源码、检查点与中间产物；`cache/` 和 `artifacts/` 保存本地缓存与输出。移除旧 INT8 / baseline 分支、重复排版和冗余基准入口。原图、缓存、模型和生成样张均不提交 Git。

GPL-3.0；具体上游版本和依赖许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。
