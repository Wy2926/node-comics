# 节点运行与恢复

发布包入口见 [Node Comics Node](../../compute-node/README.md)，源码入口见 [Classic Engine](../README.md)。中心通过[v3 整页协议](../../../docs/COMPUTE_PROTOCOL.md)管理身份、租约和结算。

## 配置

- `gpu` 是 NVIDIA CUDA 设备索引，检测／OCR／气泡模型／LaMa 使用同一设备；Qt 嵌字在 CPU 执行。GPU 不可用时拒绝接单。
- `check` / `doctor` 只做本地校验；注册和心跳才能证明连接中心。模型、源码、依赖、字体与排版参数参与引擎版本，用于记录来源；检查点必须使用 `mtu-regions-v1` 格式。兼容格式的不同构建可以恢复已付费译文，旧图像格式以 `CLASSIC_ENGINE_MISMATCH` 失败。
- `max_leases` 限制本地整页租约，中心仍以 `execution_slots` 限额；`local_pages` 限制检测／OCR 和抹字，`render_workers` 默认 `auto`，按有效 CPU 预算分配嵌字进程。嵌字不占图像计算位置；等待文本和交付回执仍占租约，不占计算线程。两池共用在途与内存预算，详见[节点配置](../../../docs/NODE_CONFIGURATION.md)。
- 本地线程和检测／修复尺寸由节点配置；目标语言声明由 Qt 字形覆盖决定。GPU 模型仅在主进程加载；Qt 缓存按渲染进程隔离，同进程绘制串行，不同进程可并行。worker 一并完成差分、覆盖层／分块编码与校验，返回编码结果；单渲染位直接在主进程执行同一整页函数，避免 IPC 开销。
- `control_ca` 可指定中心 PEM 信任文件，保留证书与主机名校验。注册、输入 GET、结果 PUT 都使用同一中心 HTTPS；输入再带当前租约令牌。节点只持有中心分配的独立凭据，不持有数据库或文本供应商密钥，也不配置对象存储。

## 状态与恢复

- 一个状态目录仅运行一个节点。私有 SQLite 日志保存领取编号、分析、冻结完成描述及二进制结果 BLOB，可能含 OCR、译文和租约令牌；限制为运行账号访问，不提交或作为通用包分发。
- 原图与抹字图受 `resident_bytes` 内存预算约束。恢复数据库只保存未完成领取、租约和待确认交付；终态回执确认后删除对应记录与文件内容，SQLite 自动回收空闲页。不设置磁盘容量领取门槛，也不按时间删除未确认交付。
- 停止时停止新领取并保留待确认交付；重启先注册对账，复用中心已持久化分析与译文。本地完成描述与结果 BLOB 在同一事务冻结，重启重交同一 multipart；响应丢失不重新计算或请求文本翻译。中心返回稳定终态回执后，同事务清除完成描述和 BLOB。
- 原生宿主使用 Job Object 清理子进程，计算进程退出后按 1、2、4…60 秒退避恢复；网络断开由计算进程重连，避免反复加载 GPU。
- 看门狗独立检查状态新鲜度与主循环进展，超过阈值后恢复计算进程。人工停止保留恢复日志，最长等待 75 秒；正常停止不触发自启。
- `supervisor.json`、`state/status.json` 提供状态；`logs/supervisor.log`、`state/logs/node.log` 在 10 MiB 时轮转，各自保留当前文件及最多 5 份备份。诊断日志不保存令牌、正文或图片；私有恢复数据库按上一项单独保护。
- `check` 输出、启动日志与 `state/status.json` 的 `cpu_resources` 显示逻辑 CPU、亲和性、可见 cgroup 配额、解析后的线程／进程预算及告警。探测在启动时进行，修改 CPU 限额后须排空重启。既有显式整数不自动改为 `auto`；`event=render_local_fallback` 按原因各告警一次：`page_budget` 表示页预算不足，`shared_memory` 表示共享段分配失败，需核查 `/dev/shm` 和内存上限。本地回退共享分析进程的原生线程，混合峰值可能高于常态预算；`mixed_render_cpu_slots` 显示此保守估计，不代表实际 CPU 利用率或硬隔离。
- 单页失败记录 `event=page_failed`、租约 ID、阶段、错误码、异常类型及文件／函数／行号，不记录原始异常消息、源码行或局部变量。本地绘字异常映射为 `CLASSIC_RENDER_FAILED`，子进程异常／退出为 `CLASSIC_RENDER_WORKER_FAILED`，检查点不一致为 `CLASSIC_RENDER_MISMATCH`；输出仍区分 `CLASSIC_OUTPUT_ENCODE_FAILED` 和 `CLASSIC_OUTPUT_TOO_LARGE`，不会被改成通用 worker 错误。这些确定性错误不自动重试；未知异常保留当前阶段的通用错误码。
- `render_layout`、`render_diff`、`render_encode` 分别记录绘字、差分和编码／校验；子进程计时合并回父进程，不写入结果身份。整段 `render` 还包括共享输入分配、复制、IPC 和清理，不能仅用三个子项之和代替它，也不能与旧版含 IPC 的 `render_layout` 直接比较。

## 升级与验收

中心与节点配套使用 v3，旧协议、旧结果上传确认和旧完成负载不兼容。v2 切换前先用旧程序排空租约，确认没有待交付结果，再停止旧节点并保留原包与私有数据。使用新包在新的专用数据目录执行 `init`，重新填写中心和节点身份；不复制旧 `node.json` 或恢复数据库，也不以旧目录直接运行 `doctor`。新配置不包含对象存储、日志数据库容量或 PNG 压缩选项。运行 `doctor`，核对中心引擎版本后启动。切换到原生服务时先停止原托管方式，同一身份不能在两个宿主同时运行。MTU 迁移须先排空旧节点，按新示例移除废弃参数并重新校验；旧图像检查点不能复用。

目标电脑分别验收 GPU 预热、中心注册、断网重连、进程崩溃恢复和正常停止。Windows 服务还需验证虚拟账户下的 GPU／网络权限、无人登录启动与重启恢复；桌面诊断不代替服务验收。

## 本地 CPU 输出对比

在引擎目录运行，先把待比较旧版的 `mtu_engine/render_pool.py` 和 `classic_node/protocol.py` 另存为可信本地基线目录中的 `render_pool.py`、`protocol.py`。该目录按 Python 源码加载，不能使用不可信文件；基线与报告放在仓库外或 ignored `artifacts/` 内，不在生产实现保留旧路径。

```powershell
.\.venv\Scripts\python.exe -m tools.validate_render_output --baseline-dir D:/samples/render-baseline --models .assets/models --output D:/samples/render-comparison.json --workers 2 --threads 1 --pages 4 --rounds 3
```

默认使用固定译文的稀疏页、多段页、透明页、无变化页和超长分块页；`--case sparse --language ar` 可缩小范围，`--mask-cache-bytes 0` 可检查无参考蒙版缓存时的成本。`--samples` 可额外读取私有 JSON 数组，每项包含 `original`、`cleaned`、`analysis` 三个本地路径（相对清单文件）；可复用 `tools.validate_mtu` 的 `.clean.png` 和 `.analysis.json`，仍使用固定译文，不执行 OCR／抹字。工具不下载图片、不连接节点、不加载 GPU 模型。

两版依次预热各自持久进程池，以同硬件、同样本和线程数比较。稳态墙钟包含共享内存分配、复制、绘字、编码、结果返回及清理；额外解码比对在计时外，启动时间单列。报告检查像素、编码字节和元数据一致、输入不变、CUDA 未初始化及共享段释放，保存每轮 CPU 时间、RSS 和吞吐，不保存私有图片或正文。RSS 是诊断父进程与子进程的采样合计，可能重复计算共享页，不是部署净增内存；合成页和 Windows 本机结果均不代表 Linux 服务、真实模型或公网端到端收益。
