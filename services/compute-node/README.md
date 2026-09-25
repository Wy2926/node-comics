# Node Comics Node

Windows x64 独立计算节点。发布包内置原生 `node.exe`、Python 运行时、推理模型与固定字体；目标电脑需要 Windows 10/11 和 Vulkan／DirectX 12 显卡驱动。

## 安装与运行

解压完整发布包到固定目录，在后台创建独立节点，再执行：

```text
node.exe init
node.exe doctor
node.exe run
```

`init` 交互读取中心、R2 origin 和节点身份，凭据不回显。`doctor` 校验文件与 GPU，并输出引擎版本；中心 `CLASSIC_ENGINE_VERSION` 需与之匹配。`run` 前台运行；临时后台使用 `start`、`status`、`stop`。

长期运行在管理员终端安装 Windows 服务：

```text
node.exe service install
node.exe service start
node.exe status
```

服务为 `NodeComicsNode`，以专用虚拟账户自动延迟启动。以 `connected=true` 和中心心跳确认在线；SCM 接受启动不等于注册成功。停止／卸载使用 `service stop`、`service remove`，卸载保留私有数据。

## 目录与升级

- `runtime/`、`engine/`、`models/`、`fonts/` 与 `release.json` 随程序保持完整；`licenses/`、`source/` 提供许可证和对应源码。
- 私有状态默认保存在 `data/`；所有命令可用 `--home <路径>` 指定新的专用目录。发布包不预置身份或状态。
- 升级先排空租约、停止节点并移除旧服务。用新包和原数据目录运行 `doctor`，核对中心版本，再安装服务；不覆盖运行中的 DLL。
- 同身份换机前停止旧宿主，复制后执行 `adopt`、`doctor` 和服务安装；`adopt` 拒绝仍有待恢复任务的状态。新增电脑使用未初始化发布包和新身份。

状态、日志、恢复规则及目标机验收见[节点运维](../classic-engine/docs/NODE_OPERATIONS.md)。

## 开发构建与验证

需要 Windows x64、PowerShell 5.1、系统 `tar.exe`、网络及约 15 GiB 工作空间。从仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File services/compute-node/build.ps1
```

构建自动下载锁定的 Go、CPython、uv、模型和字体，分别创建 OCR／LaMa 转换环境。来源与 SHA-256 由 `toolchain.lock.json`、`assets.json`、引擎模型清单及各 `uv.lock` 固定；不依赖预装开发环境或现有模型。

可传 `-Version`、`-OutputDirectory`、`-WorkDirectory`；默认输出到本模块 `artifacts/dist/`，缓存位于 `.build/`。输出目录必须不存在；同一工作目录只运行一个构建。发布清单包含逐文件摘要，随包保留源码与许可。

| 检查 | 入口 |
| --- | --- |
| 宿主与打包 | 构建自动运行 Go 测试、`go vet` 和打包测试 |
| 干净源码重建 | `python -B services/compute-node/tests/verify_clean_checkout.py --directory <新目录>`；额外需要 Git、Python 3.12 |
| 发布包 GPU 与恢复 | `tests/verify_release.py --release <解压目录> --work <新目录>`；需要 Python cryptography、真实 GPU，使用本机 HTTPS 模拟中心 |

发布包摘要用于完整性校验，代码签名与目标机器服务验收单独进行。
