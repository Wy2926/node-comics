# NVIDIA 节点验收（2026-09-16）

本机 Windows / NVIDIA GeForce RTX 4060 Laptop GPU 8 GiB，驱动 566.07。Python 3.12.10、PyTorch 2.5.1+cu124、torchvision 0.20.1+cu124；使用项目已固定的漫画检测、48px OCR、LaMa 和 Noto 字体。CUDA wheel 组合参见 [PyTorch 官方版本表](https://docs.pytorch.org/get-started/previous-versions/)，固定依赖见 [requirements-cuda.txt](../services/classic-engine/requirements-cuda.txt)。未更换模型权重或降低检测精度。

## 真实翻译

在新基线隔离 SQLite 数据库、私有且独立的 R2 前缀运行真实 API、控制执行池、维护进程、计算代理和 CUDA 引擎；使用后台接口签发独立节点身份，无共享注册凭据。样本为仓库原创 `samples/starlight-bookshop.png`（1024 × 1536），目标简体中文。

| 结果 | 实测 |
| --- | --- |
| 全链路 | `succeeded`，原图／译图均为 R2，原图字节往返一致 |
| 文本 | 11 个 OCR 文本块，11 个翻译结果；真实 gpt-5.6-luna 调用 1 次 |
| 文本用量 | 输入 241 token、输出 330 token；成本为配置估计，非供应商结算账单 |
| 图像阶段 | 检测／OCR 3.093 秒，LaMa 1.422 秒，嵌字 0.531 秒 |
| 整页 | 33.422 秒，包含上传、调度、LLM 和交付，不包含服务启动与模型下载 |
| 实际设备证据 | detector 152、OCR 2575、inpainter 2475 次被记录的卷积／线性模块调用均为 `cuda:0` |

已目视检查最终译图：主要对话气泡完成中文嵌字。样本包含小型装饰文字，仍产生 `unrecognized_regions` 质量标记；不将成功交付等同于全部细小文字识别无误。该测试证明 CUDA 路径与全链路可用，不代表所有漫画效果或峰值吞吐验收。

本地对照与脱敏报告在被忽略目录 `private-test-data/nvidia-nodes-20260916/`：`original.png`、`result.png`、`report.json`。私有任务详情、凭据和签名地址不进入仓库。

## 真实配置热更新

同一 CUDA 节点通过后台 API 更改执行位为 2、轮询周期为 1 秒、语言为简中／英文、Torch 线程为 2、OpenCV 线程为 1，代理自行拉取并确认；随后停用，再恢复原始配置。三个版本均确认应用，未创建新翻译任务或产生额外 LLM 调用。实际配置证据保存于同目录 `config-validation.json`。

## 可重复命令

```powershell
# 初次安装运行环境、固定权重和字体（已有环境可省略 -Setup）
./scripts/start-local-nvidia.ps1 -Setup -Smoke

# 完整控制端 + 节点，本地 .env 中需要已有 R2 与文本供应商配置
backend/.venv/Scripts/python.exe scripts/run_local_node.py --smoke --device cuda:0 --api-port 18128 --engine-port 18130 --directory private-test-data/nvidia-nodes-20260916

# 独立验证真实配置更新；不调用文本供应商
backend/.venv/Scripts/python.exe scripts/run_local_node.py --verify-config --device cuda:0 --api-port 18128 --engine-port 18130 --directory private-test-data/nvidia-nodes-20260916
```

启动脚本写入该目录的 `engine.json`、私有 `node.json` 和本地认证文件；编辑 `engine.json` 可声明语言与性能参数。节点通过正常后台接口预建，数据库和 R2 前缀与其他实例隔离；已保存任务编号的重复 smoke 检查复用原结果，不重复提交付费翻译。

## 自动化与浏览器检查

- 后端：311 passed、31 skipped；包含独立凭据／越权、旧协议拒绝、版本冲突、降容不撤销租约、语言筛选、重复交付及故障恢复。
- 代理：14 passed；包含多执行位排空后应用、运行期间继续拉取、缓存授权与不确定完成重放。
- 图像引擎：52 passed、1 skipped、11 subtests；包含配置文件、范围校验、字典失败保留旧配置、阶段契约和 AMD 裁剪调度逻辑。
- 后台 TypeScript 检查和生产构建通过；真实浏览器检查新增节点、错误反馈、一次性凭据显示、配置读取、缩容与停用保存，并检查截图布局。
- 当前 Docker daemon 未运行，未执行 Docker 容器部署或 PostgreSQL 实库并发套件；本机无 AMD GPU，本轮未重跑 AMD 硬件效果。此前 AMD 结果见 [AMD 验收](AMD_GPU_VALIDATION.md)。

交付为代码实现与本机实测，没有提交、推送或公开部署。
