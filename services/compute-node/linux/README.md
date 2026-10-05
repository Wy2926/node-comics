# Linux NVIDIA 计算节点

Vast 扩容采用 **固定 CUDA 基础模板 + 版本化运行包 + 每实例独立身份**。不上传完整 CUDA 镜像，不在目标机重新转换模型或安装 Python 依赖；复用官方基础镜像的 Ubuntu、Python、CUDA/cuDNN 与平台管理服务。检测、OCR、气泡分割和抹字使用 PyTorch CUDA，嵌字使用 MTU 的 Qt 离屏渲染，`nvidia-smi` 成功不等于节点就绪。

## Vast 扩容

[vast-template.json](vast-template.json) 是无凭据模板定义：固定 `vastai/base-image` 的 Linux amd64 digest，使用 SSH 启动方式和指定 on-start 脚本。运行包和安装入口来自 GitHub Release 附件，并分别锁定 SHA-256；大文件不进入 Git 历史。模板源文件不等于账号内已经保存或新实例验收成功，部署时须分别确认。

当前仓库模板是 MTU 发布草稿：发布新运行包后填写 bootstrap／运行包的版本 URL 和 SHA-256，才能用于实例启动。旧发布附件保持历史原样，不代表新引擎已部署。Vast 镜像字段使用纯 digest 引用，保存后重新打开确认完整摘要。

新增节点：

1. 在中心后台创建独立节点，中心执行位设为 **8**。
2. 在 Vast 选择该模板，填写下表身份变量，选择满足筛选条件的机器并启动。
3. 等待首次运行包下载、摘要校验及 GPU 预热完成，确认中心新鲜心跳和真实任务交付。

| 环境变量 | 内容 |
| --- | --- |
| `NODE_CONTROL_URL` | 中心 HTTPS origin，默认 `https://comics.nodelane.net` |
| `NODE_ID` | 新节点 ID |
| `NODE_TOKEN` | 新节点令牌 |
| `NODE_RESOURCE_ID` | 与中心登记一致的唯一资源 ID |

**真实身份只填到该实例，不保存进共享模板或账号级变量。** Vast 会收到实例环境变量，控制台访问者也可能读取它们；节点自身仅以 0600 权限保存身份。不要把旧节点身份复制给扩容节点。

默认检测／OCR／抹字计算 **2**、独立嵌字编码 **1**、在途 **8**、下载 **6**、交付 **6**，页缓冲预算 2 GiB。页级并发不等于共享模型同时运行次数，两计算池仍共用在途与内存预算。模板筛选 x86_64、单 GPU ≥8 GB、内存 ≥16 GB、兼容 CUDA 12.8，磁盘 48 GB。必须验证 CUDA 模型及 Qt 系统库；这些筛选不是实际吞吐或显存峰值保证。

启动脚本先校验身份和基础库，再下载并校验运行包，安装到 `/opt/node`，生成 `/var/lib/node-comics/node.json`，由现有 Supervisor 托管 `node-comics`。身份从后续启动环境移除，不传给基础镜像的环境导出步骤。运行用户 UID/GID 10001，私有状态目录 0700。既有安装版本或身份不一致时拒绝覆盖；网络中断可重试，同版本重启不重新下载运行包。新实例运行需要网络下载，首次启动时间取决于带宽。

基础环境固定 Ubuntu 24.04、系统 Python 3.12、CUDA 12.8/cuDNN 9，运行包携带锁定的 Python venv、PyTorch CUDA 依赖、MTU 源码、原生权重、词典、字体及许可；基础镜像需提供 EGL、GL、fontconfig、freetype、xkbcommon 和 D-Bus 系统库。bootstrap 校验这些库，不自动安装系统包。venv 引用 `/usr/bin/python3`，因此不能在任意 Linux 模板上直接复用。无需安装 Docker-in-Docker，也不改动 Vast 的 Caddy、portal、tunnel 管理服务；不新增应用公开端口，保留 SSH 运维。

## 状态与恢复

```sh
supervisorctl status node-comics
cat /var/lib/node-comics/state/status.json
tail -n 50 /var/lib/node-comics/supervisor.log
```

以 `phase=running`、`connected=true`、新鲜中心心跳和真实结果交付确认可用，不以进程 RUNNING 代替 GPU 验收。业务日志位于 `/var/lib/node-comics/state/logs`，Supervisor 日志有大小上限。预热失败不会注册接单。网络断开由节点重连，异常退出由 Supervisor 重启。

停止前在中心停止领取，排空租约和待交付记录，再执行 `supervisorctl stop node-comics`。stop/start 保留容器文件；没有实际挂载持久卷时 recycle/destroy 会丢失身份与未交付状态，必须先安全备份到实例外。`/workspace` 路径本身不代表持久卷。不能让同一身份在两台机器同时运行，也不能删除恢复库来绕过失败。

模板不进行静默就地升级。发布新版本使用新标签、摘要和模板；旧实例保持原版本。替换节点应先排空和停用旧节点，再启用新身份。复用旧状态升级需要独立检查协议兼容性。

## 构建与发布运行包

构建机使用 Docker Linux 容器模式，镜像只是可重复打包环境，无需推送镜像仓库。以干净已提交源码构建：

```sh
docker build --platform linux/amd64 -f services/compute-node/linux/Dockerfile --build-arg VERSION=VERSION --build-arg REVISION=COMMIT_SHA -t node-comics-compute:VERSION .
python services/compute-node/linux/export_runtime.py --image node-comics-compute:VERSION --output /absolute/release/node-comics-runtime-VERSION-linux-amd64.tar.gz
```

导出器仅提取 `/opt/node`，同时生成 `.tar.gz.json`，记录包大小、SHA-256、源镜像 ID、平台要求。将运行包、元数据、`vast_bootstrap.py` 和最终模板发布为 GitHub Release 附件；用最终文件的 SHA-256 更新模板 on-start 脚本，不能替换已发布版本的附件。源码和模板进入 Git，运行包不进入 Git。

构建不要求 GPU。基础镜像和 uv 固定 digest，Python 使用 `uv.lock`；MTU 原始源码、模型、词典、字体和许可按摘要锁定，Windows／Linux 共用资产准备。运行包包含原生 PyTorch CUDA 和 Qt，不进行自研模型转换。`mtu-assets.json`、`release.json` 记录资产摘要，源码及来源随包保留。Ubuntu apt 软件源可能变化，不承诺跨时间重建逐字节相同；扩容复用同一次发布归档。

## 普通 Linux Docker 主机

非 Vast 的普通主机可以直接运行构建镜像，需 Docker/Compose、NVIDIA Container Toolkit 和 NVIDIA CUDA 驱动。复制 `compose.yaml` 与 `node.example.json` 到独立部署目录，将配置命名为 `node.local.json` 并填写身份，权限设为 UID/GID 10001 可读、0600。

```sh
export NODE_IMAGE=node-comics-compute:VERSION
export GPU_DEVICE=0
docker compose -p gpu-node-01 run --rm node check --config /data/node.json --bundle-root /opt/node
docker compose -p gpu-node-01 up -d
```

不同节点使用不同 Compose project 和命名状态卷。`check` 校验资产及 GPU，不连接中心；`run` 才注册接单。Docker 健康检查只读状态，不重新加载模型。不要执行 `down -v`。已有 Vast 容器的手动首次安装入口为 `install_runtime.sh ARCHIVE SHA256 PRIVATE_NODE_CONFIG`，拒绝覆盖已有目录、账户和服务，不承担升级职责。

## 验证

正式回归测试只在构建阶段执行，不复制到运行包；`source/` 仅保留必要构建源码和来源信息。运行包不包含压测工具、本机 WSL 实验配置、测试图片或测试报告。

```sh
python -m unittest discover -s services/compute-node/linux -p test_container.py
python -m unittest discover -s services/compute-node/linux -p test_vast_bootstrap.py
docker compose -f services/compute-node/linux/compose.yaml config --quiet
```

Linux bootstrap 测试在 Windows 跳过，在构建镜像中执行。离线测试不代表新 Vast 实例启动、GPU 并发压测或中心联调通过；生产验收需要真实新实例、代表性页面和恢复场景。配置与协议见[节点配置](../../../docs/NODE_CONFIGURATION.md)、[计算协议](../../../docs/COMPUTE_PROTOCOL.md)。
