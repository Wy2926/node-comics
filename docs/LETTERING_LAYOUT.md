# 漫画气泡与完整嵌字引擎

2026-09-17 性能修复：已替换上游逐文字块、逐整页像素的 Python 最大内接矩形扫描，保留矩形坐标和等面积选择规则。真实页面固定输入对照中，嵌字从 3.62 秒降至 0.70 秒，译图、字形掩膜、字号及断行完全一致。详见下文“最大内接矩形性能修复”；已完成本地代码与实测，未公开部署。

2026-09-17：移除未使用的气泡内接矩形门槛，字形检查改为原生图层的局部范围；控制端复用已解码结果，PNG 编码移出设备锁，逐层设备诊断默认关闭。当前仅完成代码和本地验证，未更新运行节点。变更边界与复现见下文“局部校验与交付优化”。

2026-09-16：常规翻译已整体接入 **Manga Translator UI 的 Qt 排版／渲染模块**，固定提交 `f0307a063214f915f2b1d6e5cd3233f3bf78339f`。字号测量、自动换行、气泡适配、横竖排及字形绘制均走同一上游实现；原先“先自然排版、失败后缩放 OCR 矩形”的实现已移除。OCR、文本翻译、LaMa 与任务结算保持现有流程。本次完成代码、原生运行与容器验证，尚未重启已有本机集群或公开部署。

## 选型与接入范围

选择 [hgmzhn/manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui)，因为其已有完整的漫画 `balloon_fill`、自动断行与 Qt 原生字形流程，且与当前 OCR 区域结构兼容。相关源码为 [rendering](https://github.com/hgmzhn/manga-translator-ui/tree/f0307a063214f915f2b1d6e5cd3233f3bf78339f/manga_translator/rendering)、[auto_linebreak.py](https://github.com/hgmzhn/manga-translator-ui/blob/f0307a063214f915f2b1d6e5cd3233f3bf78339f/manga_translator/rendering/auto_linebreak.py)。

- 中日文沿原文字方向横排或竖排，由上游处理字符换行、横排禁则及竖排字形；按简中／繁中／日语选择现有 CJK 字体集合中的对应字体面。竖排换列的标点限制见下文。
- 英语及其他已开放目标语言横排，按语言使用既有断词字典／整词策略。Qt 测量与绘制使用同一字体，保持原生字形比例。
- 可靠气泡使用内区掩膜，由上游完整求解器换行、测量字号并摆放；共享气泡的多块摆放也由上游处理。无框／无法可靠提取的区域，以完整 OCR 多边形作为有界输入，仍使用同一求解器。
- 未识别文字与页边先从可用掩膜扣除，再进行排版；最后检查所有实际字形、译文完整性与最小字号。放不下时明确失败，不截断文字或交付部分结果。

没有引入上游 GUI、翻译器、HanLP 语义分词、MangaLens／YOLO 权重或新的模型服务。气泡几何继续来自已固定的 [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator/blob/84ba500ea1a4f523ca79f1c77d8c642eea3d1d07/ballontranslator/utils/imgproc_utils.py) 区域提取；适配层在最大 1024×1024 的有界窗口调用原算法，验证闭合内区包含完整源文字，保留内缩留白。开放／复杂气泡可能回退到 OCR 区域；本次样本不能代表所有漫画的气泡识别准确率。

## 可审查的上游修改

[prepare_typesetter.py](../services/classic-engine/prepare_typesetter.py) 从固定且干净的 Git 提交准备 38 个上游模块和 2 个包入口，使用独立命名空间，避免替换现有 OCR／LaMa 的 `manga_translator`。以下适配全部由可重复脚本生成并登记 SHA-256：

1. 修改绝对导入命名空间、精简包入口，提供已有气泡掩膜与已校验字典。
2. 为上游绘制循环增加观察回调，并在原生 RGBA 图层裁入页面前检查实际墨迹，避免漏报截字或把透明留白误判为越界。
3. 有掩膜时，将英文默认快捷分支导向上游已有的统一气泡求解器。
4. 允许译文重排，不沿用上游“原文只有一行就不自动换行”的默认策略。
5. 最大内接矩形改用 [typesetter_geometry.py](../services/classic-engine/typesetter_geometry.py)：裁剪前景边界、合并相同行、NumPy 批量寻找柱状图边界，保留精确最大面积与确定性等面积选择。

没有重写上游的断词、字号搜索、标点、字形栅格化或合成算法。[lettering.py](../services/classic-engine/lettering.py) 负责输入与交付检查，[typesetter.py](../services/classic-engine/typesetter.py) 负责加载和配置，[typesetter_inputs.py](../services/classic-engine/typesetter_inputs.py) 负责几何输入边界。

来源、每个原文件与准备后文件的校验和见 [manga-typesetter.json](../services/classic-engine/third_party/manga-typesetter.json)。准备与引擎启动都会核对该清单；上游源码和集成修改升级时必须一起审查。气泡提取的独立清单仍为 [ballons-translator.json](../services/classic-engine/third_party/ballons-translator.json)。

## 资源、许可与版本

| 组件 | 固定版本 | 来源及许可 |
| --- | --- | --- |
| Manga Translator UI | `f0307a063214f915f2b1d6e5cd3233f3bf78339f` | 上述 GitHub 源码；[GPL-3.0](../services/classic-engine/licenses/manga-translator-ui-GPL-3.0.txt) |
| PyQt6 | `6.11.0` | PyPI；[GPL-3.0-only](../services/classic-engine/licenses/PyQt6-GPL-3.0.txt) |
| PyQt6-Qt6 | `6.11.1` | PyPI 官方 LGPL Qt 轮子；[LGPL-3.0](../services/classic-engine/licenses/Qt6-LGPL-3.0.txt) |
| PyQt6-sip | `13.11.0` | PyPI；[BSD-2-Clause](../services/classic-engine/licenses/PyQt6-sip-BSD-2-Clause.txt) |
| BallonsTranslator | `84ba500ea1a4f523ca79f1c77d8c642eea3d1d07` | 既有固定源码；GPL-3.0 |

Qt Python 包、原始来源 URL 和 Windows／Linux 轮子 SHA-256 见 [qt-runtime.json](../services/classic-engine/third_party/qt-runtime.json)；PyQt 与捆绑 Qt 的许可分别核实，依据 [Riverbank 官方说明](https://www.riverbankcomputing.com/software/pyqt)。没有新增权重或字体；现有字体的来源、校验和与 OFL 见[语言清单](LANGUAGE_SUPPORT.md)，字典见[字典准备](HYPHENATION_DICTIONARIES.md)。

当前代码的 CPU/CUDA 引擎版本为 `mit-95227a2-classic-v9-qt-roi`，默认双进程 AMD 为 `mit-95227a2-classic-v4-dml-v8-qt-roi`；排版缓存版本为 `masked-png-v6-roi-mtu-f0307a0-qt611-noto-b85c38ec`。气泡接受条件变化会改变部分页面的布局，必须区分旧结果缓存。更新运行集群时，控制配置与节点版本需要一起切换；本次未修改现有数据库配置、任务记录或正在运行的服务。

局部校验直接读取 Qt 原生 alpha 图层，保留越界、气泡和重叠检查；整页掩膜只创建一次、局部累计。气泡提取不再要求额外的内接矩形。控制端复用已解码的产物及元数据；PNG 编码移出设备锁，擦字掩膜复用检查点。`render_layout` / `render_encode` 分别计量编码前工作与编码，`render` 为总和；Qt 和模型仍串行访问。逐层设备诊断默认关闭，需要时设置 `ENGINE_TRACE_DEVICES=1`，AMD 必需的搬运回调保留，interop 配置错误暂不修改。

离线 1200×1600、16 块文字样例的修改前后译图和字形掩膜逐像素一致。局部字形检查中位耗时约 0.100 → 0.004 秒；整页排版约 7.44 → 7.56 秒，没有证明整体提速。数据保存在 `artifacts/lettering-optimization/paired-final/report.json`；未调用在线翻译或 R2，未部署。

## 准备与验证

原生首次安装仍使用 `scripts/start-local-nvidia.ps1 -Setup` 或 `scripts/start-local-amd.ps1 -Setup`。只准备新的排版依赖与源码（不启动集群）：

```powershell
uv pip install --python services/classic-engine/.venv/Scripts/python.exe 'PyQt6==6.11.0' 'PyQt6-Qt6==6.11.1' 'PyQt6-sip==13.11.0'
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_typesetter.py
```

默认源码位于被忽略的 `engines/manga-typesetter/`，运行模块位于 `engines/manga-typesetter-runtime/`；`TYPESETTER_ROOT` 可指定已准备的运行目录。Dockerfile 自动准备相同模块，Qt 使用 `offscreen`，不要求显示器；容器依赖包括 fontconfig、xkbcommon、EGL/OpenGL 与 D-Bus 共享库。

```powershell
$env:PYTHONPATH='engines/mit-native;services/classic-engine'
services/classic-engine/.venv/Scripts/python.exe -m pytest services/classic-engine -q
services/classic-engine/.venv/Scripts/python.exe scripts/verify_lettering_languages.py
services/classic-engine/.venv/Scripts/python.exe scripts/verify_bubble_lettering.py
services/classic-engine/.venv/Scripts/python.exe scripts/verify_typesetter_samples.py

docker build -t node-comics-classic-engine:qt-validation services/classic-engine
```

`verify_typesetter_samples.py` 需要本地已有样本，每个目录包含 `original.png` 与 `stages.json`。只有重新 OCR 后的完整 ID／原文映射与保存记录相同时才复用译文；随后实际运行 LaMa 和新排版器。默认样本与输出均位于被忽略的 `private-test-data/`；可用 `--source`、`--samples`、`--language`、`--output` 指定其他已保存样本。其检查点和图片不入库，日志报告不含对白全文。

本轮证据：

- Windows 图像引擎：73 项通过、1 项环境相关跳过、11 个子检查通过；包含横竖排、共享气泡、未识别文字、缺字、长译文拒绝交付和连字符完整性。后端相关语言、配置缓存及阶段流水线 11 项通过，计算代理 15 项通过。
- 16 个目标语言离线嵌字通过；检查字体切换稳定、越南语 NFC/NFD 一致及边界内完整渲染。英／日／简中／繁中气泡对照通过；报告与图片分别在 `artifacts/lettering-languages/`、`artifacts/bubble-lettering/`。
- 两张已有漫画图实际执行 OCR → LaMa → 新排版，共 14 个文字块、9 个提取内区、2 个未识别保护区域；均输出完整尺寸，允许修改区域外逐像素一致。保存译文复用，无 LLM／图片模型／R2 调用。结果在 `private-test-data/qt-lettering-validation/`；这些有限样本不构成所有漫画风格或 OCR 语言的效果验收。
- Linux Python 3.11 容器构建及相同 16 语言／4 项气泡离线检查通过；结果见 `artifacts/linux-typesetter/`。Windows 为 Python 3.12；20 张单图和 2 张总览的解码像素与 Linux 结果完全一致。这里记录新排版器验证，不复用旧版本的客户端／GPU 部署测试作为本轮证据。

## 最大内接矩形性能修复（2026-09-17）

固定上游对每个文字块的整页掩膜执行 Python 柱状图／单调栈扫描。1024×1536、11 块样本累计遍历 17,301,504 个像素位置；实际气泡边界总面积仅 240,627 像素。

[typesetter_geometry.py](../services/classic-engine/typesetter_geometry.py) 先裁剪前景、合并连续相同行，再用 NumPy 批量求柱状图边界；精确保留最大面积和等面积时的下边界、右边界、较高矩形选择。整页输入掩膜仍保留，移除的是逐像素 Python 循环。字号搜索、换行、字形绘制、保护区域及译图缓存语义不变。

同一真实页面输入、固定短译文，CPU 排版每组预热一次、计时五次：

| 方案 | 完整嵌字 | 矩形搜索 |
| --- | --- | --- |
| 固定上游 | 3.617 秒 | 3.127 秒 |
| 有界 NumPy | 0.701 秒 | 0.198 秒 |
| 固定上游复测 | 3.901 秒 | 3.375 秒 |

矩形、像素、字形及布局全部一致。测试包含独立穷举、固定上游全小掩膜对照、孔洞／分离区域／非连续数组、24MP 稀疏页，以及英／日／简中／繁中长译文。历史图片与报告保留在本机 `private-test-data/typesetter-geometry-20260917/`；短时单图性能不代表所有漫画。

准备包的校验和已更新，运行节点需重新准备并重启；未公开部署。统一模型性能验收与最新耗时见[性能记录](CUDA_ANALYSIS_DIAGNOSIS.md)。

```powershell
services/classic-engine/.venv/Scripts/python.exe services/classic-engine/prepare_typesetter.py
$env:PYTHONPATH = "$((Get-Location).Path)/engines/mit-native"
services/classic-engine/.venv/Scripts/python.exe -m pytest services/classic-engine/test_typesetter_geometry.py services/classic-engine/test_lettering.py -q
```

## 交付错误

| 错误码 | 含义 |
| --- | --- |
| `CLASSIC_RENDER_BOUNDARY` | 实际字形无法完整留在页边内 |
| `CLASSIC_RENDER_BUBBLE_OVERFLOW` | 实际字形超出可靠气泡内区 |
| `CLASSIC_RENDER_OVERLAP` | 与未识别文字或其他已排字形重叠 |
| `CLASSIC_RENDER_NO_GLYPHS` | 至少一个译文块没有可见字形 |
| `CLASSIC_RENDER_FONT_MISSING` | 所选字体缺少译文所需字形 |
| `CLASSIC_RENDER_INPUT_INVALID` | 区域或背景检查点无效 |
| `CLASSIC_RENDER_LAYOUT_FAILED` | 未满足最小字号／译文完整性等排版要求 |

错误仍由代理白名单透传固定消息，不泄露异常原文。不能容纳的极长译文会失败，需要更短译文或人工排版。目视检查确认：该固定版本的竖排换列尚未实现完整的列首禁则，简繁中文样例存在逗号位于列首；未启用的 HanLP 语义分词也不能在本次作为修复证据。这是上游排版质量限制，不能把边界／内容完整性检查通过表述为标点精修完成；样例图保留原始结果供审查。

## 历史：替换前本机部署（2026-09-16）

以下为此前 `classic-v7-layout`／`dml-v6-layout` 部署记录，不能作为新 Qt 引擎已上线的证明。

已重新构建后台、Chrome MV3 扩展和 Web 阅读器，客户端类型／模块检查与 226 项测试通过。本机 API、控制工作进程、维护进程、计算代理与 CUDA 引擎已切至上述版本；图像节点及三个控制资源池均在线，语言报告为 16 项。保留现有图像执行位 6、文本 4、重绘 4、上传校验 2；后台可继续修改。

切换前确认无活跃任务，并在被忽略的 `private-test-data/local-cuda-nodes/backups/` 备份数据库与配置。现有漫画与任务记录保留，未添加旧数据兼容代码。运行目录仍为 `private-test-data/local-cuda-nodes/`。

真实 HTTP 检查确认后台加载本次构建、接口返回 `422 LANGUAGE_UNSUPPORTED`，引擎英／日文合成气泡各识别 1 个并完成边界内重排。检查未调用文本／图片供应商或 R2，脱敏结果在运行目录 `deployment-layout-check.json`；真实漫画效果留待手动测试。后台入口 `http://127.0.0.1:18088/admin/`，开发管理员用户名 `admin`；阅读器 `http://127.0.0.1:5173/`。已安装的解压扩展需在浏览器扩展管理页重新加载。此次为本机部署，未公开发布。
