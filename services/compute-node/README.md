# Node Comics Node

Linux NVIDIA 部署使用[Vast 在线安装模板](linux/README.md)，复用平台 CUDA，在目标机拉取源码、依赖与模型，填写独立身份后自动启动；不导出上传环境包。以下为 Windows 独立包。

Windows x64 统一使用轻量便携包 `NodeComicsNode.zip`，解压目录为 `NodeComicsNode/`，通过 `Start.cmd` 启动。不预装 Python、不修改系统 PATH、不注册服务或计划任务，默认不自启，可手动开启当前用户登录后自动启动。目标电脑需要 Windows 10/11 x64 和兼容显卡驱动；启动器不安装或更新驱动。

## 轻量便携包

ZIP 仅包含原生启动器、源码、许可证和锁定清单，不包含大型 Python 环境或模型。解压到当前用户可写的固定目录，至少预留 25 GiB 空间供首次下载、解压和缓存使用；小 ZIP 不代表运行时只占几 MB。

1. 双击 `Start.cmd`，首次选择 `cuda`（NVIDIA）或 `amd`。自动下载并校验该后端的独立 Python、依赖、模型和字体；准备完成后填写中心 HTTPS 地址、独立节点身份和凭据。后续启动复用已安装环境，不重复下载。
2. 双击 `Status.cmd` 查看状态。`connected=true` 和新鲜心跳才表示已连接，窗口打开或进程存在不等于已接入中心。
3. 双击 `Stop.cmd`，等待显示成功。它停止新领取、保留待恢复状态、退出宿主及整个计算进程树；不是仅暂停接单或清理框架缓存。正常退出最多等待 75 秒，超时清理本节点进程树，并核实进程退出；失败会明确报错，不报告“已停止”。

后端不自动切换、不降级 CPU。NVIDIA 使用 CUDA 12.6 依赖；AMD 使用独立 HIP／DirectML 环境，支持范围限定 Windows 单张 RX 6900 XT（gfx1030、设备 0），其他 AMD 型号或混合显卡需单独验收。选择后要换后端，请在新目录重新准备，不混装依赖。

首次下载失败或点击停止后可以重试，保留已校验下载；全部准备成功才原子启用 `payload/`。重复点击启动不会创建第二套安装或计算进程。手动启动等待失败会停止本次宿主；手动停止后不会立即自行重启，已启用的登录自启会在下次登录时再次启动。关掉 `Start.cmd` 的提示窗口不等于停止后台节点，使用 `Stop.cmd`。

### 可选：登录后自动启动

先通过 `Start.cmd` 完成环境下载和节点配置，再双击 `Enable-Autostart.cmd`。这仅在当前用户的 Windows“启动”文件夹添加一个本包专用快捷方式，不要求管理员、不保存 Windows 密码、不安装服务、不修改环境变量，也不会立即启动节点。下次该用户登录后隐藏启动；停在 Windows 登录界面时不会运行。依据 Windows 的[启动应用规则](https://support.microsoft.com/en-US/Windows/Experience/Startup-Boot/configure-startup-applications-in-windows)，这属于用户登录触发，不是无人登录的系统启动服务。

- `Disable-Autostart.cmd` 只移除本包的登录启动项，不会停止正在运行的节点；需要同时停止时再点 `Stop.cmd`。
- `Stop.cmd` 仍退出整个计算进程树、释放本节点显存；不取消下次登录的自启。关闭窗口不等于停止。
- `Status.cmd` 的 `autostart.registered` 表示启动快捷方式是否已注册，不等于节点在线；Windows 设置／任务管理器或安全策略另行禁用启动项时，以系统设置为准。
- 登录启动只使用已配置环境，不下载、不提示输入。网络未就绪时保留后台节点重连；失败检查 `data/logs/autostart.log`、`data/logs/supervisor.log` 及节点日志。`connected=true` 和新鲜心跳才证明已接入中心。
- 同目录覆盖升级保留已有自启设置，无需关闭或重新注册；只有移动或删除包时才先在旧目录关闭自启。移动后在新目录重新开启。不同解压目录／`--home` 各自独立，不替换其他节点的启动项。

命令行对应 `node.exe autostart enable|disable|status [--home <路径>]`；双击入口使用默认 `data/`。除了显式开启后的这个快捷方式，节点环境、配置、状态和日志仍保存在包内默认目录（或指定的 `--home`）。

## 目录与升级

默认全部位于 `node.exe` 所在目录：

- `data/node.json`：中心地址、节点身份、`node_token` 和运行配置；停止后可修改密钥。`data/` 同时保存恢复数据库、日志及运行期缓存。
- `payload/`：首次下载完成的 Python、GPU 依赖、模型、字体等；逻辑更新继续复用。
- `.setup/`：下载缓存、准备临时文件及 `.setup/app/` 运行代码缓存；启动时按新版源码清单更新代码缓存，不把覆盖残留的旧模块加载回来。
- `source/`、`licenses/`、`portable.json`、启动器与 CMD 入口：随 ZIP 更新，不含节点私有配置。

需要代理时，停止节点后在 `data/node.json` 顶层设置 `"proxy_url": "http://用户名:密码@代理地址:端口"`，然后重新启动。HTTP 代理可通过 CONNECT 转发 HTTPS；中心通信、原图下载和结果上传均使用该配置，不修改 Windows 全局代理。用户名或密码含特殊字符时需 URL 编码；此文件含明文凭据，不要分享或放入发布包。完整规则见[节点配置](../../docs/NODE_CONFIGURATION.md)。

### 直接覆盖更新

1. 用旧目录的 `Stop.cmd` 停止节点，等待确认进程退出。
2. 将新版 ZIP 内 `NodeComicsNode/` 的内容覆盖到原 `node.exe` 所在目录，保留原 `data/`、`payload/` 和 `.setup/`。旧目录名称不必改；不要在旧目录中再套一层 `NodeComicsNode/`。
3. 双击原目录的 `Start.cmd`，再用 `Status.cmd` 检查连接。已有节点配置、密钥、恢复数据和自启设置保持不变。

仅更新启动器或业务逻辑时，不因版本号、源码或启动器摘要变化重新下载依赖和模型。新代码从新版源码清单生成，旧 `payload/engine/` 不再作为运行代码来源；无需删除已安装环境。若 Python 或所选 GPU 后端的依赖实际变化，启动器会明确提示环境不兼容，需要保留数据和下载缓存后另行准备对应环境；这不属于纯逻辑覆盖更新。协议、模型要求或检查点不兼容时，仍需按[升级规范](../classic-engine/docs/NODE_OPERATIONS.md#升级与验收)处理待恢复任务，不能丢弃未交付数据。

所有命令可用 `--home <路径>` 指定私有数据目录；双击入口使用默认 `data/`。应用可控的临时／缓存路径通过子进程环境限定在上述目录，不修改用户或机器环境变量；Windows 和显卡驱动自身的缓存不承诺零写入。新配置默认单页／单渲染并发、2 个算子线程，这不是 CPU、内存或显存硬限额。

AMD 的 [MIOpen 调优数据库与内核缓存](https://rocm.docs.amd.com/projects/MIOpen/en/latest/conceptual/tuningdb.html)分别保存在 `data/cache/miopen/db/`、`data/cache/miopen/kernels/`；[rocFFT 编译缓存](https://rocm.docs.amd.com/projects/rocFFT/en/latest/how-to/runtime-compilation.html)保存在 `data/cache/rocfft/kernels.db`。启动器只为子进程设置对应路径，不改 `HOME`／`USERPROFILE`，不搬移或删除已有用户缓存。停止和覆盖更新均保留这些缓存。AMD 在接单前预热 LaMa 从 64 到配置上限的各档方形输入，首次建立缓存会增加启动耗时；NVIDIA 预热不变，不增加空闲时的后台保活。

仅下载准备、不接入中心可执行 `node.exe prepare --backend cuda` 或 `node.exe prepare --backend amd`；命令行启动为 `node.exe start`，首次也可附加 `--backend cuda|amd --from <私有配置>`。`node.exe doctor` 在节点停止时检查 GPU、模型和字体，不接单。节点身份不能与其他部署同时运行；新电脑使用新身份。彻底移除前先处理完待交付任务、关闭自启并停止，再删除该专用目录；不要删除其他部署的环境或数据。

Windows 便携包默认处理普通 v3 单图任务。需要 PDF／ZIP／CBZ 整本处理时，在私有 `data/node.json` 顶层显式设置 `"document_require_sandbox": false`，排空重启；解析启动检查通过后声明 `document_protocol:2`，中心还须允许文件领取。此模式不使用解析沙箱，权限与资源限制见[文件解析策略](../../docs/NODE_CONFIGURATION.md#文件解析策略)。节点不配置 R2／LLM 凭据。状态、日志与恢复规则见[节点运维](../classic-engine/docs/NODE_OPERATIONS.md)，文件任务能力与调度见[文件页协议](../../docs/COMPUTE_PROTOCOL.md#文件页协议)及[文件调度规则](../../docs/DOCUMENT_TRANSLATION.md#共享调度与闲时借位)。

## 开发构建与验证

需要 Windows x64、PowerShell 5.1、系统 `tar.exe` 和网络。从仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File services/compute-node/build.ps1 -Version 0.3.0
```

构建只生成便携包，不下载模型或 GPU 环境；同一个 ZIP 支持首启选择 NVIDIA／AMD，无需额外构建开关。`-ExecutionPolicy Bypass` 仅作用于本次子进程，不更改系统执行策略。首启沿用同一构建器和资产准备逻辑；AMD 上游未提供锁文件摘要的六项依赖由 `portable-amd-artifacts.json` 补充固定 URL 与 SHA-256，更新依赖时须同步验证该清单。

构建下载锁定的 Go、CPython、uv 和打包工具；目标机首次启动再准备运行依赖、MTU 原始源码、模型、词典和字体。来源与 SHA-256 由 `toolchain.lock.json`、`assets.json`、`mtu_engine/upstream.lock.json` 和 `uv.lock` 固定；PyTorch、Qt 等第三方依赖保留来源声明。Linux 在线安装也共用资产准备代码。

可传 `-Version`、`-OutputDirectory`、`-WorkDirectory`；默认输出为本模块 `artifacts/dist/NodeComicsNode/`、`NodeComicsNode.zip` 和对应摘要文件，缓存位于 `.build/`。发布名称与目录不带版本号，版本记录在启动器和 `portable.json` 中。构建输出目录必须不存在，避免覆盖已配置节点；同一工作目录只运行一个构建。发布清单保留源码摘要与所选后端的依赖标识，源码和许可随包分发。

| 检查 | 入口 |
| --- | --- |
| 宿主与打包 | 构建自动运行 Go 测试、`go vet` 和打包测试 |
| 代码覆盖与缓存复用 | `python -B -m pytest services/compute-node/test_run_node.py -q`；使用临时目录，不连接中心或下载依赖 |
| 干净源码重建 | `python -B services/compute-node/tests/verify_clean_checkout.py --directory <新目录> --version 0.3.0`；额外需要 Git、Python 3.12 |
| 发布包 GPU 与恢复 | `tests/verify_release.py --release <解压目录> --work <新目录>`；需要 Python cryptography、真实 GPU，使用本机 HTTPS 模拟中心 |

轻量包先执行 `prepare`，再运行上述 GPU 验收；测试从已准备清单读取后端，检查真实预热、断网同进程恢复、崩溃重启、停止后进程退出以及对应 PID 的 Windows GPU 显存计数归零。AMD／NVIDIA 必须各自在匹配硬件上运行；模拟进程树测试不代替另一种显卡的实际显存验收，不连接生产或发送付费任务。

发布包摘要用于完整性校验；代码签名、目标机器登录自启与 GPU 验收分别进行。
