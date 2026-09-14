# 常规图像引擎资源记录

2026-09-14 引入，仅自部署后端使用；模型与字体不打包进浏览器插件。

## 源码与依赖

引擎固定 [manga-image-translator 提交 95227a2bb0fd306cd4f0c104d57284026f991b3a](https://github.com/zyddnys/manga-image-translator/tree/95227a2bb0fd306cd4f0c104d57284026f991b3a)，其仓库声明 GPL-3.0，许可证原文保存在 [licenses](../services/classic-engine/licenses/manga-image-translator-GPL-3.0.txt)。本项目封装只直接导入所需图像模块，构建时替换根包及检测／OCR／抹字包的 eager import，避免载入上游文本翻译器、SDK 重试和日志配置。具体变换见 [prepare.py](../services/classic-engine/prepare.py)。没有引入 Stable Diffusion／FLUX 处理路线。

CPU 推理固定 PyTorch 2.5.1、torchvision 0.20.1；图像处理使用 NumPy 1.26.4、OpenCV headless 4.11.0.86、Pillow 12.3.0、FreeType Python 2.5.1。其余直接依赖均锁定于 [requirements.txt](../services/classic-engine/requirements.txt)。`pydensecrf2==1.1` 代替上游浮动 Git 下载，提供相同的 `pydensecrf` 模块；其 [PyPI 发布信息](https://pypi.org/project/pydensecrf2/1.1/)声明 MIT。

实际安装的依赖版本快照可从容器导出 `python -m pip freeze`；完整 Python 包的许可元数据与依赖清单保存在本轮验证证据中。基础镜像为 `python:3.11-slim-bookworm`，实际 Docker 镜像摘要见验证记录。

## 权重与字体

启动前按以下 SHA-256 检查全部文件，不一致时拒绝加载。下载位置在 `comics_models` 卷；下载不是每页操作，加载后模型常驻。源 URL 即使为 main，也必须与固定校验和匹配。

| 资源 | SHA-256 | 来源与许可信息 |
| --- | --- | --- |
| `detect-20241225.ckpt` | `67ce1c4ed4793860f038c71189ba9630a7756f7683b1ee5afb69ca0687dc502e` | [上游 beta-0.3 资源](https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.3)；检测器代码属上述 GPL 仓库，未取得独立权重许可声明，不能由仓库许可推定权重许可 |
| `ocr_ar_48px.ckpt` | `29daa46d080818bb4ab239a518a88338cbccff8f901bef8c9db191a7cb97671d` | 同一上游发布；48px OCR 权重没有另行核实的许可声明 |
| `alphabet-all-v7.txt` | `f5722368146aa0fbcc9f4726866e4efc3203318ebb66c811d8cbbe915576538a` | 同一上游发布的 OCR 字典，独立许可尚未确认 |
| `lama_large_512px.ckpt` | `11d30fbb3000fb2eceae318b75d9ced9229d99ae990a7f8b3ac35c8d31f2c935` | [dreMaz/AnimeMangaInpainting 模型卡](https://huggingface.co/dreMaz/AnimeMangaInpainting)声明 MIT，漫画／动画微调 LaMa Large |
| `NotoSansMonoCJK-VF.ttf.ttc` | `b861b923e105a437f30ce12573350e899ee75766c4a6e9eef6d46788fb839e76` | 固定上游提交 fonts 目录内的 Noto 字体；[Noto CJK 官方许可](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE)为 SIL OFL 1.1，原文随镜像保留 |

构建后的运行字体目录只保留该 Noto 文件，渲染 fallback 也显式绑定 Noto。上游附带的微软雅黑、MS Gothic、Arial 和其他字体从工作目录移除，不在本链路使用。字体字形缺失时返回渲染错误，不把缺字框当成可用交付。

以上区分了代码、模型与字体来源，没有给尚不明确的权重补造许可结论。当前完成边界为本地实现与测试；若后续要分发引擎或用于公开收费服务，独立权重许可仍是需要补齐的资料。

许可文件来源与校验和：[资源证据](evidence/classic-resources.json)。运行时 `/models/manifest.json` 包含逐项实际文件校验记录。
