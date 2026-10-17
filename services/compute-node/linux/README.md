# Vast NVIDIA 节点在线部署

Vast 使用 **已有 CUDA 基础环境 + 固定源码版本 + 目标机在线安装**。不导出、上传或分发 Python／CUDA 环境包，不从开发机搬运 venv、模型或镜像。普通 Linux Docker 运行方式见末节；Vast 不需要 Docker-in-Docker。

## 新增节点

1. 在中心后台预先创建独立节点，中心执行位设为 **8**。
2. 用已发布的完整 Git commit 生成并保存 [Vast 模板](vast-template.json)，每个实例填写自己的身份。
3. 启动后等待依赖、模型、字体下载和 GPU 预热，确认中心新鲜心跳及真实任务结果。

| 实例环境变量 | 内容 |
| --- | --- |
| NODE_CONTROL_URL | 中心 HTTPS origin，默认 https://comics.nodelane.net |
| NODE_ID | 新节点 ID |
| NODE_TOKEN | 新节点令牌 |
| NODE_RESOURCE_ID | 与中心登记一致的唯一资源 ID |

共享模板不保存真实身份，不给扩容实例复制旧节点身份。Vast 会收到这些实例变量；节点配置保存为 /var/lib/node-comics/node.json，权限 0600。

模板固定 vastai/base-image 的 amd64 digest，采用 SSH 启动方式。当前支持 Ubuntu 24.04、Python 3.12、NVIDIA CUDA 12 驱动；模板筛选 CUDA 12.8、单 GPU ≥8 GB、内存 ≥16 GB、磁盘 48 GB。这些筛选不是实际吞吐或显存峰值保证。

## 一条在线安装路径

[vast_bootstrap.py](vast_bootstrap.py) 负责：

1. 检查基础环境、CUDA 驱动和文件解析能力，apt 只补齐缺少的 Python 构建、Qt 与 libseccomp 系统库，**不安装或替换 CUDA 和 NVIDIA 驱动**。
2. 在服务器拉取固定 commit 的必要源码。
3. 下载固定版本 uv，按 uv.lock 执行 uv sync --locked，在该版本自己的 venv 中安装依赖。
4. 复用 [资产准备器](../../classic-engine/tools/prepare_mtu.py)，在线下载带摘要的原生模型、上游源码、字体、词典及许可；不进行模型转换。
5. 新版本探测文件解析能力，验证模型摘要、Python 原生依赖、Qt 字体及真实 GPU 预热，通过后才切换并交给 Supervisor。文件解析沙箱不可用时仍可安装和启动单图节点，不声明文件协议能力。当前已完成版本重跑仅检查身份、配置和服务状态，不重复资产全量校验、GPU 预热或 Supervisor 重载；真正启动工作进程仍执行完整运行预检。

PyTorch／ONNX Runtime 等仍需要匹配的 Python 包；这些包在目标机按锁文件拉取，不复制 Vast 的 CUDA 环境。首次安装依赖网络与磁盘，后续复用缓存。节点保持正常出网，不加防火墙或主进程断网限制，也不改变 Vast 的 Caddy、portal、tunnel 服务。

模板源文件带占位符，不能直接启动。源码提交并发布后生成模板：

~~~sh
python services/compute-node/linux/prepare_template.py --revision COMMIT_SHA --output /absolute/path/vast-template.json
~~~

生成器从指定 commit 读取模板和 bootstrap 的原始 Git blob，计算摘要并下载同一公开 URL 逐字节核对；未发布、内容不一致、旧环境包协议模板或网络验证失败均拒绝生成。脏工作区、Windows CRLF 和选择旧 commit 不影响摘要。生成模板不等于推送代码、保存平台模板、购买实例或完成新节点冷启动验收。Vast 镜像字段采用纯 digest 引用，保存后重新打开确认完整摘要。

已有 Vast 容器也使用同一入口：

~~~sh
python3 vast_bootstrap.py --revision COMMIT_SHA --config /absolute/private/node.json --start
~~~

首次也可由四个 NODE_* 实例变量生成配置。重复执行同一版本保留身份、状态、依赖和下载缓存。省略 --start 只准备和验证版本，不切换链接、不修改或启动 Supervisor；准备不同版本仍要求先排空和停服务，避免与旧工作进程同时预热占用显存。只保留 Python 安装入口，不再套一层 shell 安装脚本。

### 临时开发版本

支持不提交、不推送的临时版本。把本次运行所需源码放到**测试节点上的**独立检出目录，再运行该目录的安装器；不要传输本地 venv、模型、凭据或状态目录，也不要用生产节点身份启动第二个测试实例。

~~~sh
python3 /absolute/checkout/services/compute-node/linux/vast_bootstrap.py \
  --source-dir /absolute/checkout --expected-current CURRENT_VERSION --start
~~~

首次安装省略 expected-current，并提供该测试节点自己的 --config 或四个 NODE_* 变量。已有节点先按下节停止领取、排空、停服务。源码只采集一次，版本号和安装内容共用这份快照；只选择运行源码和明确列出的配置模板，拒绝目录／文件链接，排除私有配置。相同内容复用 local-* 版本，内容改变产生新版本；依赖和模型仍由目标机按锁文件在线安装、复用缓存。临时版本不能冒充正式 commit，也不能生成正式 Vast 模板。

## 缓存、状态与版本

| 路径 | 内容 |
| --- | --- |
| /opt/node | 当前版本链接 |
| /opt/node-releases/VERSION | 该版本源码、venv 和模型 |
| /var/cache/node-comics | Git、uv、模型与字体下载缓存 |
| /var/lib/node-comics | 独立身份、恢复库、工作目录和日志 |

安装失败保留下载缓存；uv 重试网络请求，模型／字体下载支持 Range 续传，不支持 Range 的源自动重新下载。安装器显式启用 uv 缓存并通过硬链接复用，覆盖基础镜像可能设置的 UV_NO_CACHE 和复制模式，避免同机升级反复下载、复制同一批 Python 包。校验完成前不切换当前版本。

配置、资产清单和版本完成标记原子发布。配置校验统一在已安装的锁定 venv 中执行，不依赖宿主系统 Python 恰好装有 psutil；私有配置相对路径按最终状态目录解析，发布前验证。未写入完成标记的版本重试时从校验缓存重建资产，不把一个存在但截断的 release.json 当作完成；已完成版本禁止就地重建。这个恢复分支可能重做本地解压／校验，只在未完成安装重试时发生。

状态与代码独立。已有实际持久卷可通过 --data-dir 指定专用状态目录；/workspace 这个路径本身不代表持久卷。stop/start 保留实例文件，recycle/destroy 是否保留取决于实际卷；回收前必须排空并备份身份和状态。document_spool_bytes 是应用预算，不是磁盘硬配额。

默认检测／OCR／抹字计算 2、在途 8、下载 6、交付 6，页缓冲预算 2 GiB。CPU 与嵌字线程根据亲和性及 cgroup 配额分配。已有私有配置保持不变，详见[节点配置](../../../docs/NODE_CONFIGURATION.md)。

## 升级与回滚

不静默更新到 main 或 latest。升级前确认中心／节点协议和数据库兼容，在中心停止领取并排空任务，再停止服务：

~~~sh
supervisorctl stop node-comics
cat /opt/node/.source-revision
python3 vast_bootstrap.py --revision NEW_COMMIT --expected-current OLD_COMMIT --start
~~~

安装器检查待交付记录和文件工作目录，不能将等待 LLM 的无租约任务当作排空。新版本校验及服务配置预写通过后，原子切换 /opt/node；旧版本目录保留。切换后捕获到配置发布或 Supervisor 启动错误，会停止候选服务并恢复旧链接和配置，保留停止状态供检查后重试；回退自身失败明确报告 rollback_failed，必须人工检查。断电／SIGKILL 不能由异常处理保证回退，恢复后先核对实际链接、配置和服务状态，不自动猜测版本。

回滚使用相同入口，把目标和 expected 对调：

~~~sh
supervisorctl stop node-comics
python3 vast_bootstrap.py --revision OLD_COMMIT --expected-current NEW_COMMIT --start
~~~

已有目标版本复用其环境，身份和状态不删除。跨协议／数据库版本仍需配套回滚中心，不能只切换节点程序。不要同时运行两个相同身份。

## 运行、恢复与排障

~~~sh
supervisorctl status node-comics
cat /var/lib/node-comics/state/status.json
tail -n 50 /var/lib/node-comics/supervisor.log
~~~

以 phase=running、connected=true、新鲜中心心跳和真实结果交付确认就绪；进程 RUNNING 或 nvidia-smi 成功不代表模型已预热。业务日志在 state/logs，Supervisor 日志有大小上限。

控制面暂不可达或工作进程异常时，服务入口按 5–60 秒退避重试；已运行节点的网络故障由原有协议重连。正常停止不自动拉起。安装脚本失败仍执行 Vast 原有平台入口，保留 SSH／控制台排障能力。

预检代码区分 NODE_CONFIG_INVALID、NODE_STATE_DISK_LOW、NODE_GPU_DRIVER_UNAVAILABLE、NODE_PARSER_SANDBOX_UNAVAILABLE、NODE_CONTROL_TLS_UNREACHABLE，不输出令牌、签名地址或文件内容。早于工作进程启动的错误还记录在 /var/lib/node-comics/startup-logs。model_warmup=pending 不能作为 GPU 验收。

PDF／ZIP 解析仅在子进程内使用 Landlock ABI ≥3 与 libseccomp，不依赖用户命名空间、privileged 或 SYS_ADMIN；节点主进程正常连接中心和存储。每次启动实测解析及越界拒绝能力；不通过时报告 document_protocol=null，仅运行单图任务，不绕过文件解析隔离。已有文件工作目录但沙箱能力丢失时仍拒绝启动，避免遗留任务被静默搁置。需要文件任务时应更换合适宿主，安装脚本不修改宿主内核。文件工作目录在等待 LLM 时保留，详见[整本文件翻译](../../../docs/DOCUMENT_TRANSLATION.md)。

## 验证

~~~sh
python -m unittest discover -s services/compute-node/linux -p test_container.py
python -m unittest discover -s services/compute-node/linux -p test_vast_bootstrap.py
python -m unittest discover -s services/compute-node/linux -p test_bootstrap_transactions.py
python -m unittest discover -s services/compute-node/linux -p test_prepare_template.py
python -m unittest discover -s services/compute-node/linux -p test_preflight.py
NODE_TEST_SANDBOX=1 python services/compute-node/linux/test_parser_sandbox.py
~~~

Linux bootstrap 测试在 Windows 跳过。离线测试与真实部署验收分别报告：首次在线安装、同版本重跑、失败续传、升级／回滚、进程异常恢复、正常停止及真实 GPU 任务。测试机接入隔离中心不代表生产切换或新租实例冷启动已验收。

## 普通 Linux Docker 主机

普通 Docker 主机可在目标主机从源码构建 [Dockerfile](Dockerfile)，配合 NVIDIA Container Toolkit 和 [Compose](compose.yaml) 运行；不导出环境包搬运到 Vast。构建固定 CUDA 镜像和 uv digest，依赖、模型与字体由构建机在线拉取。

~~~sh
docker build --platform linux/amd64 -f services/compute-node/linux/Dockerfile -t node-comics-compute:VERSION .
docker compose -p gpu-node-01 run --rm node check --config /data/node.json --bundle-root /opt/node
docker compose -p gpu-node-01 up -d
~~~

复制 compose.yaml 与 node.example.json 到独立部署目录，按 Compose 约定设置 NODE_IMAGE、GPU_DEVICE 和私有 node.local.json。每个节点使用不同 project 和状态卷，不执行 down -v。Compose 默认共享内存上限 2 GiB；Vast 使用实例自身挂载。容量上限不等于预分配内存或真实吞吐。

平台参考：[Vast Docker 环境](https://docs.vast.ai/guides/instances/docker-environment)、[模板启动脚本](https://docs.vast.ai/guides/templates/advanced-setup)。
