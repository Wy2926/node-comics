# Classic Engine

常规漫画翻译的图像引擎和整页计算节点：NCNN Vulkan 检测／OCR、DirectML FP32 LaMa 抹字、字体嵌字。文本翻译由中心执行。

直接部署使用 [Windows 独立节点包](../compute-node/README.md)；本目录用于引擎与节点协议开发。

## 开发环境

需要 Python 3.11+、uv；GPU 路径需要 Windows 10/11、DirectX 12 与 Vulkan 驱动。在本目录执行：

```powershell
$env:UV_PROJECT_ENVIRONMENT = '.venv-lama'
uv sync --locked --extra test --extra build
.\.venv-lama\Scripts\python.exe -m manhua_engine.cli download --ocr-language all
.\.venv-lama\Scripts\python.exe -m tools.build_lama --models models
```

OCR FP32 转换与模型准备见 [ENGINE.md](ENGINE.md#安装与模型)，完整独立包使用[统一构建入口](../compute-node/README.md#开发构建与验证)。运行时不下载模型；字体需要覆盖目标语言，来源和许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。

## 连接中心

在后台创建独立节点，复制 [node.example.json](node.example.json) 为 `node.local.json`，配置中心 HTTPS 地址、R2 精确 origin、身份、资源 ID、模型和字体路径：

```powershell
.\.venv-lama\Scripts\python.exe -m classic_node check --config node.local.json
.\.venv-lama\Scripts\python.exe -m classic_node run --config node.local.json
```

`check` 校验本地模型并输出引擎版本；将中心 `CLASSIC_ENGINE_VERSION` 配为该值，配置文本供应商并启用常规翻译。`run` 才注册和领取任务，以中心心跳确认在线。

节点身份与语言见[节点配置](../../docs/NODE_CONFIGURATION.md)，执行、日志与恢复见[节点运维](docs/NODE_OPERATIONS.md)，消息与交付见[计算协议](../../docs/COMPUTE_PROTOCOL.md)。

## 验证

本目录运行 `.\.venv-lama\Scripts\python.exe -m pytest -q`。中心联调从仓库根目录使用已安装后端依赖的 Python：

```powershell
python -m pytest backend/tests/test_compute_v2.py backend/tests/test_compute_node_v2.py -q
```

真实 GPU 集成需将 `CLASSIC_TEST_MODELS` 指向模型目录，并使用引擎与后端依赖齐备的环境运行 `test_compute_node_v2.py -k real_vulkan`。文本和对象存储仍为隔离适配器；效果、性能与公网接入分别验证，工具见 [ENGINE.md](ENGINE.md#性能与验证)。
