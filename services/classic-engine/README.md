# MTU 计算节点

常规漫画翻译的 v3 图像计算节点。组装固定版本的 [Manga Translator UI](https://github.com/hgmzhn/manga-translator-ui) DBNet 检测与文字蒙版、PP-OCRv6 medium、MangaLens、LaMa Large 和 PyQt6 气泡适配嵌字；段落合并与阅读顺序使用 [BallonsTranslator](https://github.com/dmMaze/BallonsTranslator) 原生分组。神经网络统一使用 CUDA；中心执行文本翻译，节点输出无损 WebP 覆盖层。实现边界与支持范围见 [ENGINE.md](ENGINE.md)。

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

## 部署与协议

- [Windows 独立节点包](../compute-node/README.md)、[Linux NVIDIA](../compute-node/linux/README.md)
- [节点配置](../../docs/NODE_CONFIGURATION.md)、[运行与恢复](docs/NODE_OPERATIONS.md)
- [v3 计算协议](../../docs/COMPUTE_PROTOCOL.md)、[第三方来源](THIRD_PARTY.md)

结果继续使用稀疏无损 WebP，已协商的超长页面使用分块包。二值覆盖 alpha 和 `source-atop` 保留原图透明度；SQLite 原子冻结结果与完成记录，终态回执后清除。MTU 迁移必须先排空旧节点，再以新配置启动；旧图像检查点不能交给新引擎继续绘制。
