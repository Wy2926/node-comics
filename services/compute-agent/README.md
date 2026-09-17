# 独立翻译节点

每台机器按物理设备运行一个计算代理和一个图像引擎。代理只向控制 API 领取阶段与交付结果，无数据库、R2 或供应商凭据。后台预建节点、签发独立身份，服务端配置执行位；不支持共享 Token 自注册。

完整字段和协议见[节点配置](../../docs/NODE_CONFIGURATION.md)，调度规则见[集群设计](../../docs/TRANSLATION_CLUSTER_DESIGN.md)。新数据库基线 `shared_0001`，旧数据不迁移、不自动清空。

## 接入步骤

1. 后台“计算节点”添加节点，填写稳定资源 ID（如 `machine-a:cuda:0`）及执行位；保存一次性显示的节点 ID 与密钥。
2. 复制 [node.example.json](node.example.json) 为私有 `node.local.json`，填写控制 HTTPS 地址、该节点身份及本机引擎 URL／独立引擎密钥。
3. 按 [CUDA 模板](../classic-engine/engine.cuda.example.json) 或 [DirectML 模板](../classic-engine/engine.directml.example.json) 配置设备、相同资源 ID、模型／字体／锁目录、语言和线程数。相对路径按配置文件所在目录解释。
4. 启动引擎，代理开始报告设备、拉取服务端配置并应用；后台可查看目标／已应用版本、语言和应用错误。

```powershell
# 引擎：需要已安装依赖、固定源代码和模型；ENGINE_TOKEN 是本机独立密钥
$env:ENGINE_CONFIG_FILE = 'D:/node-config/engine.json'
$env:PYTHONPATH = 'D:/Project/nodelane/node-comics/engines/mit-native'
cd services/classic-engine
.venv/Scripts/python.exe -m uvicorn server:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log

# 另一终端运行代理（仓库根目录）
$env:NODE_CONFIG_FILE = 'D:/node-config/node.json'
backend/.venv/Scripts/python.exe services/compute-agent/agent.py
```

文件外也可用 `CONTROL_URL`、`NODE_ID`、`NODE_TOKEN`、`ENGINE_URL`、`ENGINE_TOKEN` 注入代理启动连接信息。本机 HTTP 需显式 `CONTROL_ALLOW_HTTP=true`；跨机器使用 HTTPS。执行位、轮询和阶段超时只从服务端取得。

正常退出先停止新领取，在宽限时间内完成当前阶段；超时恢复由控制端租约负责。配置更新先排空所有当前阶段后应用，停用不强杀正在计算的模型。设备内仍有安全串行锁；执行位大于 1 表示多个在途阶段，不能据此推断 GPU 同时执行多个模型。

## 本机完整运行

NVIDIA 已在 RTX 4060 Laptop GPU 跑通真实翻译，见[实测报告](../../docs/NVIDIA_GPU_VALIDATION.md)。

```powershell
./scripts/start-local-nvidia.ps1 -Setup -Smoke
# 已准备的环境，运行服务并保持：
./scripts/start-local-nvidia.ps1
# AMD 使用独立匹配依赖的环境：
./scripts/start-local-amd.ps1 -Setup -Smoke
```

启动脚本需要后端 `.env` 中的 R2 和文本供应商配置。图像引擎与代理仅接收白名单环境；私有文件、图片对照、报告保存在被忽略目录。不同 GPU 依赖不能混装：DirectML 使用 torch 2.4.1，CUDA 使用 2.5.1+cu124；切换设备应使用独立环境或明确重新安装对应依赖。AMD 先前硬件验证见 [AMD 说明](../../docs/AMD_GPU_VALIDATION.md)。

独立引擎启动根据 `runtime.languages` 补全所需字典与许可文件，按固定校验和验证，下载失败不接单；完整缓存不重复下载。`torch_threads`、`opencv_threads`、缓存限额可远程热更新；interop 线程数、设备与 LaMa 子进程数为本地启动参数。

逐层设备执行诊断默认关闭。硬件验收时可为引擎设置 `ENGINE_TRACE_DEVICES=1`，健康信息中的 `execution_tracing` 表示是否启用；未启用时 `executed` 为空，不表示模型未运行。该开关不移除 AMD 必需的数据搬运回调。设备锁仅保护模型调用，CPU 后处理和独立单进程 Qt 排版可与下一页推理重叠；单个模型和单个排版进程内部保持串行。引擎最多接纳 3 个阶段，节点至少 2 个执行位才能利用跨页流水。配置、计时与验证见[引擎流水线](../../docs/ENGINE_PIPELINE.md)。

## 容器

```powershell
docker build -t node-comics-compute-agent:local services/compute-agent
docker build -t node-comics-classic-engine:cpu services/classic-engine
# CUDA 镜像需要匹配 GPU 的容器运行环境
docker build --build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124 -t node-comics-classic-engine:cuda services/classic-engine
```

仓库 Compose 的 `./scripts/bootstrap.ps1 -Start -Classic` 首次只启动控制服务和图像引擎；在后台添加与 `deploy/engine.json` 资源 ID 相同的节点，将返回的 `NODE_ID`、`NODE_TOKEN` 写入私有 `deploy/.env.local`，再次启动即可运行代理。`CLASSIC_ENGINE_TOKEN` 只用于同机引擎。新 Compose 项目 `node-comics-nodes` 使用新数据库卷 `nodes_postgres`。

远程机器可分别挂载引擎 JSON、代理 JSON、持久模型缓存和同机共享锁目录，引擎不发布公网端口。控制服务独占 R2 和数据库；用户图片只在节点有界内存缓存中保留。

## 验证

```powershell
backend/.venv/Scripts/python.exe -m pytest services/compute-agent -q
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_node_management.py backend/tests/test_compute_http.py -q
# 在带固定上游 PYTHONPATH 的引擎环境中：
services/classic-engine/.venv/Scripts/python.exe -m pytest services/classic-engine -q
```

HTTP 集成使用真实代理／控制进程与模拟图像、文本响应，检查双节点交付、心跳、故障恢复与一次结算；不能作为翻译效果证据。真实 CUDA 图片、配置热更新和当前跳过项另列于实测报告。
