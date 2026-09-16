# 开源气泡识别与嵌字保护

2026-09-16：已接入 **BallonsTranslator** 的气泡区域提取模块，配合边界约束排版和具体错误码。未引入自研气泡检测器。代码为 [speech_bubbles.py](../services/classic-engine/speech_bubbles.py) 适配层与 [lettering.py](../services/classic-engine/lettering.py) 排版保护层。

## 来源与接入

采用 [dmMaze/BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) 的 `extract_ballon_region` 与依赖的 `enlarge_window`，固定到提交 `84ba500ea1a4f523ca79f1c77d8c642eea3d1d07`，来自 [imgproc_utils.py](https://github.com/dmMaze/BallonsTranslator/blob/84ba500ea1a4f523ca79f1c77d8c642eea3d1d07/ballontranslator/utils/imgproc_utils.py)。项目在漫画排版中使用背景气泡区域；所选模块基于边缘、轮廓和区域填充，不是需要额外权重的深度学习模型。

仅保留这两个函数及必要 import，算法和语句未修改，仅规范行尾空白；[vendored 源码](../services/classic-engine/third_party/ballons_translator.py)、[来源及 SHA-256 清单](../services/classic-engine/third_party/ballons-translator.json)、[GPL-3.0 许可证](../services/classic-engine/licenses/BallonsTranslator-GPL-3.0.txt) 随引擎交付。其余 GUI、翻译器、模型和字体不引入；依赖使用现有固定 OpenCV 4.11.0.86／NumPy 1.26.4，无额外模型下载或远程调用。

适配层以 OCR 框定位最多 1024×1024 的局部搜索区，把上游提取的掩膜转成气泡内区。上游返回整块背景、掩膜触及裁剪边缘、面积不合理、未包含当前文字框中心、多个文字块归属不明时，不将其当成可靠气泡。有效掩膜内缩留白，选取完全位于内区的排版矩形；最终字形必须全部位于气泡和页边内，且不覆盖未识别文字。

闭合气泡优先受识别边界约束；无框对白、开放或复杂气泡、共享气泡的模糊归属回退到 OCR 框。这是漫画开源工具的区域提取方案，不能据此宣称所有漫画气泡均准确识别。

## 原失败原因与修复

现有 4 条 `CLASSIC_RENDER_FAILED` 记录的 OCR 区域和译文，在同尺寸合成白背景复现：2 条文字扩展到页边、2 条覆盖未识别文字区域。固定版本上游排版按译文扩展文字框，没有约束扩展后的页面及相邻区域边界；原引擎保护检查拒绝交付，代理又将所有 HTTP 422 压成同一个错误码。

现在先尝试自然排版，出现越界、重叠或无可见字形时，从干净背景重新在原文字框／识别到的气泡内完整渲染。不会裁掉越界字形后假报成功。仍无法安全排版时返回具体错误，不反复执行确定失败的版式。

| 错误码 | 含义 |
| --- | --- |
| `CLASSIC_RENDER_BOUNDARY` | 无法在页边内完整排版 |
| `CLASSIC_RENDER_BUBBLE_OVERFLOW` | 无法在气泡内完整排版 |
| `CLASSIC_RENDER_OVERLAP` | 与未识别文字区域重叠 |
| `CLASSIC_RENDER_NO_GLYPHS` | 没有可见字形 |
| `CLASSIC_RENDER_FONT_MISSING` | 缺少译文所需字形 |
| `CLASSIC_RENDER_INPUT_INVALID` | 区域或背景检查点无效 |
| `CLASSIC_RENDER_LAYOUT_FAILED` | 排版计算异常 |

代理只透传白名单错误码，使用固定中文消息，不传递异常原文或漫画文字。引擎不支持目标语言时返回 `LANGUAGE_UNSUPPORTED`。

CPU/CUDA 引擎版本 `mit-95227a2-classic-v7-layout`，默认双进程 AMD 版本 `mit-95227a2-classic-v4-dml-v6-layout`，排版缓存版本 `masked-png-v4-bounded-layout-noto-b85c38ec`。控制服务与引擎版本必须匹配，没有旧协议／缓存／数据兼容处理。

## 验证与限制

```powershell
$env:PYTHONPATH='engines/mit-native;services/classic-engine'
services/classic-engine/.venv/Scripts/python.exe -m pytest services/classic-engine -q
services/classic-engine/.venv/Scripts/python.exe scripts/verify_lettering_languages.py
services/classic-engine/.venv/Scripts/python.exe scripts/verify_bubble_lettering.py
```

合成检查覆盖闭合／开放气泡、整页白底、共享气泡、保护区、污染回滚及错误透传。16 语言离线嵌字仍可验证；气泡脚本额外输出英／日文的横排和竖排对照，实际调用上述开源函数及正式渲染链路，断言字形全部位于气泡内、其余像素不变，结果在被忽略的 `artifacts/bubble-lettering/`。

4 条失败布局回放可在不重新调用 LLM 的情况下验证。回放使用已保存 OCR／译文与合成背景，不访问 R2，不等同于原图最终交付或真实漫画气泡准确率验收。

本轮结果：后端全套 326 通过／32 跳过，后续相关接口与计量回归 41 通过；图像引擎 66 通过／1 跳过（另 11 个子检查），计算代理 15 通过。16 语言离线渲染、英日气泡对照、4 条失败布局回放均通过。后台生产构建及 Chrome 表单／JSON、多语言、三个执行池、错误恢复与 390px 窄屏操作检查通过。跳过项主要需要显式配置的隔离 PostgreSQL 和 GPU 环境。

## 本机重新部署（2026-09-16）

已重新构建后台、Chrome MV3 扩展和 Web 阅读器，客户端类型／模块检查与 226 项测试通过。本机 API、控制工作进程、维护进程、计算代理与 CUDA 引擎已切至上述版本；图像节点及三个控制资源池均在线，语言报告为 16 项。保留现有图像执行位 6、文本 4、重绘 4、上传校验 2；后台可继续修改。

切换前确认无活跃任务，并在被忽略的 `private-test-data/local-cuda-nodes/backups/` 备份数据库与配置。现有漫画与任务记录保留，未添加旧数据兼容代码。运行目录仍为 `private-test-data/local-cuda-nodes/`。

真实 HTTP 检查确认后台加载本次构建、接口返回 `422 LANGUAGE_UNSUPPORTED`，引擎英／日文合成气泡各识别 1 个并完成边界内重排。检查未调用文本／图片供应商或 R2，脱敏结果在运行目录 `deployment-layout-check.json`；真实漫画效果留待手动测试。后台入口 `http://127.0.0.1:18088/admin/`，开发管理员用户名 `admin`；阅读器 `http://127.0.0.1:5173/`。已安装的解压扩展需在浏览器扩展管理页重新加载。此次为本机部署，未公开发布。
