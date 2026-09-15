# 独立图像计算节点

每台机器按物理设备部署一个计算代理和一个常驻 `classic-engine`。代理通过控制服务的 HTTPS 内部接口领取单个阶段，输入由该阶段的短期授权读取；只有控制服务访问数据库、R2 和文本供应商密钥。节点无需共享图片目录，也不需要 R2 或 LLM 密钥。

`analyze → text 与 inpaint 并行 → render` 的阶段状态由控制服务保存。节点完成 OCR 后释放图像位；等待文本时可以处理其他用户的 OCR 或 LaMa。常规与重绘的调度、公平份额、实时窗口及套餐权重由控制服务确定。

## 构建与独立机器运行

在仓库根目录构建：

```powershell
docker build -t node-comics-compute-agent:local services/compute-agent
docker build -t node-comics-classic-engine:cpu services/classic-engine
```

独立节点的 Compose 示例（保存于该机器，环境文件不入库）：

```yaml
services:
  classic-engine:
    image: node-comics-classic-engine:cpu
    environment:
      ENGINE_TOKEN: ${ENGINE_TOKEN}
      ENGINE_DEVICE: cpu
      ENGINE_RESOURCE_ID: ${ENGINE_RESOURCE_ID}
      ENGINE_CACHE_BYTES: 268435456
      ENGINE_CACHE_TTL_SECONDS: 900
      ENGINE_LOCK_DIR: /locks
      OMP_NUM_THREADS: 4
    volumes:
      - models:/models
      - /var/run/node-comics-devices:/locks
    restart: unless-stopped
  compute-agent:
    image: node-comics-compute-agent:local
    environment:
      CONTROL_URL: https://control.example.com
      CLUSTER_NODE_TOKEN: ${CLUSTER_NODE_TOKEN}
      NODE_ID: ${NODE_ID}
      NODE_NAME: ${NODE_NAME}
      ENGINE_URL: http://classic-engine:8000
      ENGINE_TOKEN: ${ENGINE_TOKEN}
      NODE_HEARTBEAT_SECONDS: 10
      NODE_POLL_SECONDS: 1
    stop_grace_period: 16m
    restart: unless-stopped
volumes:
  models:
```

机器 A 可设置 `NODE_ID=machine-a-cpu`、`ENGINE_RESOURCE_ID=machine-a:cpu`；机器 B 分别使用 `machine-b-cpu`、`machine-b:cpu`。同物理设备的资源标识在重启和容器重建后保持稳定，控制端拒绝将同一设备重复注册为多个节点。同主机的设备锁目录必须共享；锁文件只含锁字节，没有用户图片。

图像引擎不发布公网端口。只有代理向控制端发起连接。控制端按现有运维入口注入 `CLUSTER_NODE_TOKEN`，引擎使用独立 `ENGINE_TOKEN`。`CONTROL_URL` 默认强制 HTTPS；本机隔离测试可明确设置 `CONTROL_ALLOW_HTTP=true`。节点正常终止时停止领取，已有阶段在宽限时间内完成；异常终止由控制端租约恢复。

### GPU 参数

Windows AMD RX 6900 XT 已完成原模型混合 CPU/DirectML 路径的真实翻译与同图对照，见[AMD 部署与验收](../../docs/AMD_GPU_VALIDATION.md)。使用同一阶段协议，保留原漫画检测、48px OCR、LaMa 与嵌字器；OCR 解码与 Fourier 模块明确在 CPU 执行。

Dockerfile 支持可配置 PyTorch wheel 源，例如 CUDA 12.4 的构建参数 `--build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124`，运行设置 `ENGINE_DEVICE=cuda:0` 并分配匹配 GPU。CPU 与 CUDA 设备使用相同阶段协议；CUDA 不可用时启动失败，不静默改用 CPU。OCR/LaMa 共用同一设备锁，当前每台引擎安全容量为 1。

设备映射、驱动、显存、CUDA 镜像与真实样本吞吐需要在目标硬件验收；CPU 镜像的契约测试不代表 GPU 或两台物理机器测试通过。

## 数据与恢复边界

- 原图只在单次请求内存中存在，单图传输上限 24 MiB、解码上限 24 百万像素。
- OCR 区域和可恢复 PNG 掩膜检查点总共不超过 4 MiB，持久化在控制端数据库。
- LaMa 结果只存引擎内存 LRU 缓存，有严格字节上限与绝对 TTL。缓存键绑定任务、原图摘要、配置及 OCR 检查点。
- `inpaint` 返回缓存键，不上传中间图；`render` 在缓存丢失或换节点时重新抹字，继续使用控制端已保存的译文，不重复 LLM 调用。
- 渲染回复上限 96 MiB，控制端再次验证尺寸、掩膜外像素和原图归属，再持久化最终译图。
- 每个阶段使用独立租约。心跳、输入与结果都绑定节点和租约令牌；已过期执行不能覆盖新代次。
- 完成通知发生网络错误时只重发同一份结果，不重新计算。代理不记录原图、OCR、译文、签名 URL、凭据或异常正文。

模型、字体的现有固定版本、下载摘要及许可记录位于 `services/classic-engine/prepare.py` 与 `licenses/`；本次没有升级模型或字体。

## 可重复的隔离检查

```powershell
cd services/compute-agent
python -m unittest -v test_agent.py
```

仓库根目录（引擎镜像包含已固定的依赖，测试挂载当前源码；不加载权重、不调用文本供应商）：

```powershell
docker run --rm --entrypoint python -v D:/Project/nodelane/node-comics/services/classic-engine:/opt/engine node-comics-classic-engine:cpu -m unittest -v test_runtime.py test_stage_contract.py test_local_inpainting.py
```

控制端文本预算与租约验证：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_classic.py tests/test_classic_parallel.py -q
```

`tests/test_classic_parallel_postgres.py` 用 `RUN_POSTGRES_CONCURRENCY=1` 显式启用。它只接受名为 `nodecomics_concurrency_test` 的隔离数据库，配置 `TEST_PG_HOST`、`TEST_PG_PORT`、`TEST_PG_USER`、`TEST_PG_PASSWORD`，每例创建独立随机 schema；未启用时显示跳过。

真实 HTTP 多进程协议检查（约 20–30 秒）：

```powershell
cd backend
.venv/Scripts/python.exe -m pytest tests/test_compute_http.py -q
```

此测试在临时目录创建 SQLite 与图片对象，启动真实控制 API、控制执行池、维护进程和两个独立计算代理；仅图像引擎与文本供应商返回模拟结果。它通过真实 HTTP 受理、上传、鉴权、心跳和下载完成整条链路，随后强制退出正在渲染的代理，验证另一节点恢复同一页、保留已完成译文且仅结算一次。进程和临时数据与运行服务隔离，退出时关闭所有测试进程。这是同机多进程协议验收，不代替两台物理机器、R2 在线或真实模型效果测试。
