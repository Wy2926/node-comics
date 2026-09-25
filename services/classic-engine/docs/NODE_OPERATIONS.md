# 节点运维入口与验收

节点发布与运维入口为 [Node Comics Node](../../compute-node/README.md)：Windows 原生 `node.exe`、专用运行时、模型和固定字体组成可移动目录。初始化、诊断、监督运行、Windows 服务安装及管理均为程序内置命令；先前的 PowerShell 管理脚本和隔离计划任务脚本已删除。

节点内部仍使用整页 v2 协议、独占恢复日志、任务幂等恢复与现有直传流程。新的原生宿主补充独立进程看门狗、Windows Job Object、退避重启和 SCM 自动恢复。

## 干净检出重建（2026-09-25）

统一入口为 `services/compute-node/build.ps1`，固定工具链、依赖、原始模型和字体来源与摘要，并自动导出运行模型。完整命令和锁文件说明见[开发构建与验证](../../compute-node/README.md#开发构建与验证)。

本次使用 `tests/verify_clean_checkout.py` 收集 88 个 Git 可见源码文件，在独立临时仓库提交为 `04c607cd1db38cd316dfff98b570eb67593db5e0`，再克隆构建。检出前后 `git status --porcelain` 均为空，初始工作目录不存在；没有复制已有模型、Python 环境或下载缓存。该重建检查只提交临时快照，不修改项目仓库的索引、HEAD 或远端。

- 全量下载、转换、编译、测试和打包用时 465 秒，退出码 0；Go 宿主测试、`go vet` 和 6 项打包测试全部通过。
- 重新导出的 OCR 三个运行文件与 LaMa ONNX 摘要均与此前验证模型一致。LaMa 导出与原模型对照最大误差 `4.172325134277344e-06`，ONNX 图检查通过；运行时验证 10 个模型文件。
- ZIP 包含 5,973 个清单文件及 `release.json`，逐项 CRC、SHA-256 和清单一致性检查通过，不含初始化身份、任务数据库和日志。大小 670,362,112 字节；SHA-256 为 `eac5197d7504b8a569db091ba138205c8198ec3acac1be03caa67d1841a21fcb`。
- 构建证据保存在仓库本机忽略目录 `artifacts/node-clean-03/` 的 `inputs.json`、`build.log`、`result.json` 和 `archive-verification.json`。此后仅补充验收文档并清理文件末尾空行，未改动已验证构建逻辑。

这是本机 Windows 上的干净源码、空缓存重建；不是全新 Windows 虚拟机验收，也不承诺所有系统之间的 ZIP 逐字节一致。

## 本机验证边界（2026-09-25）

- Go 原生宿主 9 项用例及 `go vet` 通过：发布文件损坏／越界拒绝、机器绑定、独占锁、计算进程崩溃后自动恢复、人工停止、宿主被强杀时计算进程由 Job Object 清理、状态失活检测、HTTPS origin 校验、私有目录边界及既有文件保护、SCM 控制通道启动时停止请求不丢失（模拟请求，未安装真实服务）。
- 本次干净重建的 ZIP 解压到含中文和空格的新目录，从系统临时目录启动，并设置无效 `PYTHONHOME/PYTHONPATH` 和错误的父进程 `NODE_TOKEN`。实际 GPU 检查通过：RX 6900 XT、NCNN Vulkan、DirectML FP32、16 种目标语言字体覆盖。不依赖原 Python 安装、虚拟环境、仓库工作目录或用户字体。
- 使用包外中文数据目录及本机隔离 HTTPS 中心完成真实程序验收：首次注册连续两次 HTTP 503 后恢复；中心持续不可用超过 60 秒后离线，恢复时保持同一个 GPU 进程；强杀计算进程后宿主重新预热并注册；正常停止后不自启。共 4 次注册请求、72 次心跳请求、1 次计算进程恢复。证据在 `artifacts/node-clean-03/runtime-acceptance/result.json`；未领取图片任务，没有连接公网生产中心。
- 本次包的引擎版本为 `manhua-ncnn-v1-2846070f2664125639d423e111edb251`。与旧包相比，运行模型摘要未变；构建统一引擎源码行尾，因此源码参与计算的引擎版本改变。生产切换必须使用当前包 `doctor` 的版本，不能沿用旧包版本值。
- 此前引擎与节点操作相关 Python 用例 72 项通过；本次构建另执行 6 项打包校验。原先中心与节点协议联调 22 项通过、2 项未启用的真实 GPU 集成验收跳过；本次不将它们描述成新的公网翻译效果验收。
- 本机当前为非管理员会话，SCM 服务安装、虚拟账户的 GPU/HTTPS 权限、无人登录开机恢复尚未实机验收；代码使用真实 SCM API，但单元测试和桌面 GPU 检查不能代替 Session 0 验收。
- 未发布远端下载或代码签名，未发起收费图片翻译。

本次干净重建产物：`artifacts/node-clean-03/release/NodeComicsNode-0.1.0-windows-x64.zip` 与同名 `.zip.sha256`。此前 `services/compute-node/artifacts/distribution/` 中的旧包保留，不作为本次构建证据。ZIP 只纳入发布清单文件，不包含 `data`、凭据、任务 SQLite 或运行日志；解压校验同时覆盖 ZIP CRC，程序运行前检查文件 SHA-256。

## 当前生产节点

现有生产节点仍由 `NodeComics-Compute` 托管，使用 `data/compute-node/node.json`。本次隔离保留了旧引擎源码快照 `data/compute-node/previous-engine`，并将既有任务的工作目录固定到该快照，避免研发中的新字体／版本在进程自动恢复时意外接管线上。

新的可移动发布包采用固定 Noto 字体，引擎版本已改变。切换生产前须先准备并验证 Windows 原生服务，排空旧节点、停止旧托管任务、同步中心 `CLASSIC_ENGINE_VERSION`，再启动新节点并确认中心注册和心跳。不能直接让同一节点身份在两个宿主上同时运行。旧私有状态保留，用于恢复与回退，不复制进通用分发包。

此处的旧任务仅是当前线上切换前的状态记录，不是新方案的运行要求；新电脑使用 `node.exe`，不安装计划任务脚本。
