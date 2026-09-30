# Linux NVIDIA 计算节点镜像

复用 `classic_node` v3，不依赖 Windows 原生宿主。镜像内置 Python 3.12、锁定 Python 依赖、CUDA 12.8.1 / cuDNN 9、检测/OCR/LaMa 推理模型及固定 Noto 字体；运行时不下载模型。检测与 OCR 主干仍使用 Vulkan，抹字使用 CUDA，不能仅以 `nvidia-smi` 判断就绪。

## Vast 镜像模板

模板配置见 [vast-template.json](vast-template.json)，镜像版本为 `wyang9996/node-comics-compute:0.1.0-cuda12.8.1`。这是交给 Vast 保存的无凭据模板定义，不代表本地文件存在就已经在 Vast 账号中创建成功。发布时必须确认 Docker Hub 可匿名拉取并记录 digest，再在账号内保存模板和完成新实例验收。

选择 **docker ENTRYPOINT** 启动方式，启动参数留空，不选择 SSH/Jupyter，不设置 on-start 脚本，不开放端口。Vast 的 SSH/Jupyter 模式会替换镜像入口，见[官方启动方式说明](https://docs.vast.ai/guides/templates/template-settings)。本镜像不提供 SSH/网页管理服务；通过 Vast 实例日志和中心节点状态运维。

创建实例前，只需将以下环境变量填为新节点的独立身份：

| 字段 | 内容 |
| --- | --- |
| `NODE_CONTROL_URL` | 中心 HTTPS 地址，模板默认 `https://comics.nodelane.net` |
| `NODE_ID` | 中心后台创建的节点 ID |
| `NODE_TOKEN` | 该节点令牌 |
| `NODE_RESOURCE_ID` | 与中心登记一致的唯一资源 ID |

中心执行位设为 8。镜像的页级计算工作位为 2、在途上限 8、下载/交付各 6、页缓冲预算 2 GiB。**不要把真实身份保存到共享模板或账号级环境变量**，否则扩容可能复用身份；每次创建实例填写独立值。缺失/占位身份会拒绝启动，已有状态目录不允许静默改绑节点或中心。

入口以 UID/GID 10001 运行，将身份以 0600 权限原子写入 `/data/node.json`，不打印令牌；预热成功后才注册领取。重复启动复用同一身份及 `/data/state`。模板初始筛选单卡 ≥8 GB 显存、≥16 GB 内存、兼容 CUDA 12.8，磁盘 24 GB；选择 x86_64 机器，并验证主机提供 Vulkan/graphics 驱动。筛选不等于实际显存、吞吐验收。

实例日志出现 `warmup_complete`、`registration` 后，还要确认中心新鲜心跳、配置版本已应用及真实任务交付。启动日志对外输出经过节点原有脱敏规则处理的运维事件。日志保留在 `/data/state/logs`；无持久卷时，销毁/重建前必须排空和备份，普通停止/启动仍保留容器文件。

## 构建

在仓库根目录使用支持 BuildKit 的 Docker（Linux 容器模式）：

```sh
docker build --platform linux/amd64 -f services/compute-node/linux/Dockerfile -t node-comics-compute:linux-cuda .
```

版本化发布使用干净、已提交的源码构建，填写 `--build-arg VERSION=<版本>` 与 `--build-arg REVISION=<完整提交SHA>`，镜像标签使用新版本而不覆盖旧标签。登录 Docker Hub 后执行 `docker push <镜像>:<版本>`；随后从无登录环境检查可拉取性与 digest。镜像、源码标签和模板中的版本必须对应，不使用漂移的 `latest` 进行生产扩容。

构建不要求 GPU，需要网络及足够磁盘/内存用于两个独立 CPU 模型转换环境。基础镜像和 uv 固定 digest；Python 包使用 `uv.lock`，模型、上游 OCR 源码、字体和许可按 SHA-256 校验。OCR/LaMa 复用 Windows 构建的转换器及锁文件，转换环境支持 Windows x64 和 Linux x86_64。首次下载和转换较慢，后续使用 BuildKit 下载缓存和独立资产层；业务代码变化不会重新转换模型。当前仅支持 `linux/amd64`。

最终镜像不包含 Torch/pnnx、训练检查点及整网 OCR 验证模型。`/opt/node/release.json` 记录模型与字体等资产摘要；代码与依赖版本由最终镜像 digest 固定。Ubuntu 系统包来自构建时的软件源，不承诺不同时间重建的镜像逐字节相同；生产扩容应复用一次构建并发布的同一个 digest。对应构建源码在 `/opt/node/source`，运行源码在 `/opt/node/engine`，许可及来源信息随镜像保留。

## 目标机器准备

- Linux x86_64、兼容 CUDA 12.8 的 NVIDIA 驱动，以及可用的 NVIDIA Vulkan ICD。
- Docker Engine、Compose v2、[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)，已配置 Docker GPU 支持。容器使用 `compute,utility,graphics`，无需桌面或 X server。
- 宿主机已有 CUDA 可以保留；不挂载宿主 CUDA 目录，容器使用自身用户态依赖。版本关系见 [ONNX Runtime CUDA 要求](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)。
- 中心 HTTPS 可达；节点不需要公开端口、数据库凭据、对象存储或文本供应商密钥。

## 启动与扩容

每个节点使用一个独立部署目录，放入本目录的 `compose.yaml`，并将 `node.example.json` 复制为 `node.local.json`。从中心后台创建独立身份，修改中心地址、节点 ID、令牌、唯一资源 ID。每个实例使用不同身份和状态卷，不克隆恢复库。

容器以 UID/GID `10001:10001` 运行。Linux 上配置文件设为该用户可读、其他用户不可读，例如 `sudo chown 10001:10001 node.local.json` 和 `sudo chmod 600 node.local.json`。新建命名状态卷会继承镜像 `/data` 的所有权。不要将带身份或状态的目录作为镜像构建输入。

在此部署目录中执行（下面是 Linux shell 命令）：

```sh
export NODE_IMAGE=node-comics-compute:linux-cuda
export GPU_DEVICE=0
docker compose -p gpu-node-01 run --rm node check --config /data/node.json --bundle-root /opt/node
docker compose -p gpu-node-01 up -d
docker compose -p gpu-node-01 ps
docker compose -p gpu-node-01 exec node cat /data/state/status.json
```

镜像需预先通过可信镜像仓库或 `docker save` / `docker load` 分发；仓库推送单独授权。生产将 `NODE_IMAGE` 换成已发布的 `registry/repository@sha256:...`。不同节点使用不同 Compose project 名称，避免共享命名卷。`GPU_DEVICE` 可指定宿主 GPU 索引或 UUID；容器只暴露所选 GPU，本地 `engine.gpu` / `engine.inpaint_gpu` 从 0 开始，但仍需通过实际预热验证 Vulkan/CUDA 映射。

`check` 校验模型、字体并执行 GPU 预热，不连接中心。`run` 才注册接单；健康检查读取新鲜状态及中心心跳，不重新加载模型。断网会显示 unhealthy，但 Docker 不因 unhealthy 自动重启；节点自行重连，进程退出才按重启策略恢复。日志在 `/data/state/logs/node.log`；启动失败另看 `/data/startup-logs/node.log`，不会将凭据打印到控制台。默认状态目录固定 `/data/state`，健康检查依赖此路径。

示例配置为同时计算 2 页、最多在途 8 页、下载和交付各 6 路，中心执行位对应设为 8；`local_pages` 与中心执行位不是同一种并发。实际吞吐和显存峰值需用代表性页面测量，预热通过不等于并发压测通过。部署前分别验收断网、进程崩溃、宿主机重启、丢回执重交和正常停止。Docker Desktop/WSL 的 CUDA 可见性不代表生产 Linux Vulkan 路径通过验收。

## 已有 Vast 容器

Vast 基础镜像通常是非特权容器，不能嵌套运行 Docker。已有实例可复用本地构建镜像的 `/opt/node` 运行包，由现有 Supervisor 托管；不重新下载或转换模型，不改动平台管理服务，也不开放新端口。仅适用于 Ubuntu 24.04 x86_64、系统 Python 3.12，且已有 CUDA 12.8、cuDNN 9、GL/Vulkan 和兼容 NVIDIA 驱动的实例。该模式依赖目标系统库，隔离程度不等同于直接运行完整镜像。

先在构建机导出一次无身份的运行包：

```sh
python services/compute-node/linux/export_runtime.py --image node-comics-compute:linux-cuda --output /absolute/release/runtime.tar.gz
```

导出器同时生成 `.tar.gz.json`，记录源镜像 ID、包 SHA-256、大小与环境要求。通过 SSH 分发包、`install_runtime.sh`、`node-comics.supervisor.conf` 和节点独立的私密 `node.json`；配置的 `state_dir` 改为 `/var/lib/node-comics/state`，不要复用其他实例身份。安装器与 Supervisor 配置放在同一目录，然后以 root 执行：

```sh
bash install_runtime.sh /absolute/runtime.tar.gz VERIFIED_SHA256 /root/node.json
supervisorctl status node-comics
cat /var/lib/node-comics/state/status.json
```

安装器只支持首次安装：遇到已有运行目录、状态目录、账户或 Supervisor 配置会拒绝覆盖。校验包摘要、模型及真实 GPU 预热全部通过后，才注册并启动 `node-comics` 服务。使用专用 UID/GID 10001、0600 身份文件、0700 状态目录；日志有大小上限，退出异常自动重启。安装中途失败时先查看失败位置并修复，不删除已生成的状态再盲目重跑。后续扩容复用同一运行包及安装器，只更换身份配置。

实例没有挂载持久卷时，stop/start 保留容器数据，但 recycle/destroy 会丢失身份和未交付状态。操作前在中心停止领取、确认交付清空并将状态安全备份到实例外；不能将 `/workspace` 路径本身当作持久性保证。停止节点用 `supervisorctl stop node-comics`，不要停止 Vast 的 Caddy、portal 或 tunnel 管理服务。此安装器不处理现有实例的就地升级。

## 停止、升级与恢复

先在中心停用新领取，等待已接任务完成及待交付记录清空，再 `docker compose -p gpu-node-01 stop`。停止后可用以下命令检查恢复库：退出码 0 表示无待恢复记录，1 表示仍有记录；其他失败也应先检查日志，不应删除状态。

```sh
docker compose -p gpu-node-01 run --rm node pending --config /data/node.json
```

同协议升级更换镜像后 `up -d`，保留原身份和命名卷。异常退出会保留 SQLite 中冻结的结果，重启对账后重交。不执行 `down -v`，不对未确认交付按年龄清理，不让同一身份在两个宿主同时运行。回滚先检查协议与状态兼容性；新版本预热失败时不要绕过检查放量。

## 离线检查

```sh
python -m unittest discover -s services/compute-node/linux -p test_container.py
docker compose -f services/compute-node/linux/compose.yaml config --quiet
docker run --rm --network none --entrypoint python node-comics-compute:linux-cuda /opt/node/source/compute-node/linux/verify_assets.py
```

这些检查不能代替目标机器真实 GPU 与中心联调。运行与恢复语义见[节点配置](../../../docs/NODE_CONFIGURATION.md)和[计算协议](../../../docs/COMPUTE_PROTOCOL.md)。
