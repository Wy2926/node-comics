# Classic Engine 计算节点

2026-09-19：从 `D:\Project\Github\manhua-engine` 的当前工作区迁入图像流水线、模型清单、原测试和构建工具；该源仓库当时没有可引用的 HEAD。源文件未删除或修改，迁入文件的原始摘要见 [IMPORT.json](IMPORT.json)。原引擎说明保留在 [ENGINE.md](ENGINE.md)，上游版本和许可证见 [THIRD_PARTY.md](THIRD_PARTY.md)。不复制漫画、翻译缓存、凭据、旧虚拟环境或生成产物到版本控制。

生产入口是单进程的 `classic_node`：主动向中心领取整页租约，直接读取受限 R2 URL，执行检测／OCR、AOT-GAN 抹字和嵌字，通过中心提供的临时 PUT URL 并发直传最终 PNG 到 R2，再提交元数据回执。LLM 由中心调用，节点无需文本供应商、数据库或 R2 长期凭据。抹字算法是迁入引擎的 AOT-GAN，并非旧引擎的 LaMa。节点不监听 HTTP 端口，也不需要旧 `compute-agent`。

外部协议见 [COMPUTE_PROTOCOL.md](../../docs/COMPUTE_PROTOCOL.md)，具体消息与中心迁移见 [v2 实施说明](../../docs/COMPUTE_V2_IMPLEMENTATION.md)。

## 安装与准备

要求 Python 3.11+、Vulkan 驱动（CPU 用 `gpu: -1`）、已准备模型与覆盖目标语言的字体。运行时不下载模型或断词词典。`uv.lock` 固定 Python 依赖；为避免覆盖旧 PyTorch 环境，下面使用新的 `.venv-ncnn`。

```powershell
cd services/classic-engine
$env:UV_PROJECT_ENVIRONMENT = '.venv-ncnn'
uv sync --locked --extra test
.\.venv-ncnn\Scripts\python.exe -m manhua_engine.cli download --ocr-language all
.\.venv-ncnn\Scripts\python.exe -m manhua_engine.cli devices
```

日文 MIT OCR 的 FP32 构建命令见 [原引擎安装说明](ENGINE.md#安装与模型)。也可复制已验证的 `models/ocr-fp32/backbone.ncnn.param`、`backbone.ncnn.bin`、`decoder.onnx` 和 `build.json`；节点启动时核对构建来源、原始检查点与三个运行文件的 SHA-256。检测、AOT、其他 OCR 权重按包内 `models.json` 验证。`models/`、`build-models/` 均不提交。

本次本机验收所需权重已复制到此服务的被忽略 `models/`，不依赖源仓库目录。Windows 使用系统 Arial／微软雅黑／游ゴシック／Malgun Gothic；Linux 安装 Noto Sans CJK，或在 `engine.font` 显式填写有授权的字体路径。字体不随仓库分发，实际内容摘要与模型、算法、依赖、OCR 语言、排版参数一起生成引擎版本。多机需要相同版本才能领取同一配置的任务。

## 配置与运行

1. 中心使用当前 `shared_0007_upload_verified_info` 空数据库，不保留旧协议或旧上传数据适配。
2. 在后台创建节点，保存其独立身份和凭据；填写稳定 `resource_id`，执行位表示承接的整页数量。
3. 复制 [node.example.json](node.example.json) 为 `node.local.json`，填写中心 HTTPS origin、R2 **精确端点 origin**、节点身份、资源 ID。密钥也可用 `NODE_TOKEN` 环境变量提供。
4. 运行 `check` 取得实际 `version`，设置中心 `CLASSIC_ENGINE_VERSION` 为该值；中心配置文本供应商后启用 `CLASSIC_ENABLED=true`。
5. 运行 `run`。配置文件中的相对路径以该文件所在目录解析。

```powershell
.\.venv-ncnn\Scripts\python.exe -m classic_node check --config node.local.json
.\.venv-ncnn\Scripts\python.exe -m classic_node run --config node.local.json
```

`check` 只校验本地模型、字体并预热，不注册或连接中心；`run` 才进行真实注册。不能把 `check` 成功视为已接入集群。生产连接强制 HTTPS，禁止凭据 URL、任意 R2 主机和重定向；本地测试使用显式适配器，不提供生产明文／中心转发回退。

私有中心可用 `control_ca` 指定 PEM 信任文件（相对配置文件解析），保留证书和主机名校验；R2 客户端不使用这个信任文件。本机使用真实 `.env`、Docker 中心和 Windows AMD 节点的启动入口为 `scripts/start-local-classic.ps1`，实际调用与运行记录见[本机真实服务](../../docs/CLASSIC_LOCAL_RUNTIME.md)。

`max_leases` 是节点愿意承接的本地上限，中心仍按数据库中的 `execution_slots` 限额；`local_pages` 是同时运行的有限图像计算步骤数，默认 2，可设为 1。默认最多 8 个整页租约，下载、分析提交与交付使用独立网络池，等待文本不占计算线程。等待文本和等待完成回执持续占接单名额；本地线程、NCNN 内部线程和 OCR 池不由中心修改。默认每个配置只加载一种来源 OCR；需另一种来源模型时，修改 `engine.ocr_language` 并使用新引擎版本，不能把目标语言当作 OCR 来源。

`state/` 是有界、只用于恢复的私有 SQLite 日志，保存领取编号、未确认分析和冻结结果，不保存 R2 URL。它可能包含 OCR、译文和租约令牌，应仅允许运行账号访问且不加入备份／Git。原图和抹字图按 `resident_bytes` 预算保留在有界页面内存中。已确认终态删除本地内容；日志文件空间可复用，`journal_bytes` 限制数据库页数，磁盘另需预留一次 SQLite 回滚日志空间。不要在任务未完成时手动删除日志。一个状态目录只允许运行一个节点进程。

Ctrl+C 停止新领取，保留仍需恢复的交付；无法中断的模型步骤结束后丢弃失效租约结果。重启首先注册对账；已持久化分析／译文由中心恢复，本地冻结结果直接重交，不重新 OCR 或重新调用 LLM。

## 验证

```powershell
# 图像算法和节点下载／日志／截止时间测试
.\.venv-ncnn\Scripts\python.exe -m pytest -q

# 仓库根目录：中心与节点联调，不请求外部模型或存储
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_compute_v2.py backend/tests/test_compute_node_v2.py -q

# 真实 Vulkan 样张验收，额外安装中心测试依赖到隔离环境
uv pip install --python services/classic-engine/.venv-ncnn/Scripts/python.exe -r backend/requirements.txt
$env:CLASSIC_TEST_MODELS = (Resolve-Path services/classic-engine/models).Path
services/classic-engine/.venv-ncnn/Scripts/python.exe -m pytest backend/tests/test_compute_node_v2.py -k real_vulkan -q
```

最后一项在 Windows 生成英文／日文标准字体样张，执行真实检测、OCR、Vulkan 抹字和嵌字，经节点直传并由中心登记终态。文本采用固定测试回复，R2 为隔离适配器；测试端下载解码核对最终图，结果在 `artifacts/v2-smoke/`。这不是自然漫画翻译准确率、线上 LLM／R2、Linux／NVIDIA 或生产部署验收。历史吞吐只保留在 ENGINE.md，不当作迁入节点的新性能结论。
