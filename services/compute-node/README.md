# Node Comics Node

Linux NVIDIA 部署使用[Vast 在线安装模板](linux/README.md)，复用平台 CUDA，在目标机拉取源码、依赖与模型，填写独立身份后自动启动；不导出上传环境包。以下为 Windows 独立包。

Windows x64 独立计算节点。发布包内置原生 `node.exe`、Python 运行时、推理模型与固定字体；目标电脑需要 Windows 10/11 和 支持 CUDA 12.6 的 NVIDIA 显卡驱动。

## 安装与运行

解压完整发布包到固定目录，在后台创建独立节点，再执行：

```text
node.exe init
node.exe doctor
node.exe run
```

`init` 交互读取中心 HTTPS origin 和节点身份，凭据不回显。v3 单图任务直接从中心读取临时原图并提交无损 WebP 覆盖层。文件任务的 `document_protocol:2` 仅在支持非特权解析沙箱的 Linux 宿主启用：输入一次下载，中间页留本地持久目录，最终 ZIP 上传 R2。Windows 不声明该能力，普通单图不受影响。节点只拿限定对象的短期签名，不配置 R2／LLM 凭据。`doctor` 校验文件与 GPU，并输出引擎版本；构建指纹仅用于追溯；兼容节点可直接接单，无需修改中心构建版本配置。`run` 前台运行；临时后台使用 `start`、`status`、`stop`。

文件 OCR／渲染与单图共用同一身份、GPU runtime、固定执行池和内存预算；后台 `document_slots` 为保守并发，优先级与闲时借位见[文件调度规则](../../docs/DOCUMENT_TRANSLATION.md#共享调度与闲时借位)。OCR 检查点本地落盘、只回传文本后释放租约，整本 LLM 等待不占节点页缓冲；PDF／ZIP 解析与打包也由此宿主执行，中央 document-worker 只处理整本文本。协议及升级边界见[文件页协议](../../docs/COMPUTE_PROTOCOL.md#文件页协议)，旧任务排空后配套升级中心与节点。

长期运行在管理员终端安装 Windows 服务：

```text
node.exe service install
node.exe service start
node.exe status
```

服务为 `NodeComicsNode`，以专用虚拟账户自动延迟启动。以 `connected=true` 和中心心跳确认在线；SCM 接受启动不等于注册成功。停止／卸载使用 `service stop`、`service remove`，卸载保留私有数据。

## 目录与升级

- `runtime/`、`engine/`、`upstream/`、`models/`、`fonts/`、`hyphenation/`、`mtu-assets.json` 与 `release.json` 随程序保持完整；`licenses/`、`source/` 提供许可证和对应源码。
- 私有状态默认保存在 `data/`；所有命令可用 `--home <路径>` 指定新的专用目录。发布包不预置身份或状态。
- 升级先排空租约、停止节点并移除服务，再用新包运行 `doctor`、核实协议与配置兼容性后安装服务；不覆盖运行中的 DLL。不兼容数据的初始化与恢复限制见[升级规范](../classic-engine/docs/NODE_OPERATIONS.md#升级与验收)。
- 同身份换机前停止旧宿主，复制后执行 `adopt`、`doctor` 和服务安装；`adopt` 拒绝仍有待恢复任务的状态。新增电脑使用未初始化发布包和新身份。

状态、日志、恢复规则及目标机验收见[节点运维](../classic-engine/docs/NODE_OPERATIONS.md)。

## 开发构建与验证

需要 Windows x64、PowerShell 5.1、系统 `tar.exe`、网络及至少 25 GiB 工作空间。从仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File services/compute-node/build.ps1
```

Windows 构建自动下载锁定的 Go、CPython、uv、MTU 原始源码、CUDA 原生模型、词典和字体。来源与 SHA-256 由 `toolchain.lock.json`、`assets.json`、`mtu_engine/upstream.lock.json` 和 `uv.lock` 固定。Windows 包携带 PyTorch CUDA、Qt 及来源声明；Linux 在目标机在线安装，共用资产准备代码。

可传 `-Version`、`-OutputDirectory`、`-WorkDirectory`；默认输出到本模块 `artifacts/dist/`，缓存位于 `.build/`。输出目录必须不存在；同一工作目录只运行一个构建。发布清单包含逐文件摘要，随包保留源码与许可。

| 检查 | 入口 |
| --- | --- |
| 宿主与打包 | 构建自动运行 Go 测试、`go vet` 和打包测试 |
| 干净源码重建 | `python -B services/compute-node/tests/verify_clean_checkout.py --directory <新目录>`；额外需要 Git、Python 3.12 |
| 发布包 GPU 与恢复 | `tests/verify_release.py --release <解压目录> --work <新目录>`；需要 Python cryptography、真实 GPU，使用本机 HTTPS 模拟中心 |

发布包摘要用于完整性校验，代码签名与目标机器服务验收单独进行。
