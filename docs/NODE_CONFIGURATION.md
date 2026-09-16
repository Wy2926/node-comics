# 翻译节点身份与通用配置

2026-09-16 已实现。新数据库基线 `nodes_0001`，仅支持后台预建节点与独立凭据，不提供旧数据库、共享注册 Token 或旧注册请求兼容路径。现有数据库不自动删除，也不能直接运行新基线；新部署使用独立数据库／卷。

## 后台与身份

管理后台 → 计算节点 → 添加翻译节点：填写名称、稳定物理资源 ID 和服务端配置。服务端生成不可自选的 `node_id` 与独立随机凭据；明文仅在创建／轮换响应中返回，数据库保存 SHA-256 摘要。配置列表、监控和配置拉取不返回密钥。

物理资源 ID 一次绑定且唯一，例如 `machine-a:cuda:0`。引擎本地文件必须使用相同 ID。节点报告仅可修改实际引擎版本、设备和能力，不能创建身份、修改资源绑定、扩容或解除停用。请求同时带 `Authorization: Bearer <node_token>` 与 `X-Node-Id`；一个节点的凭据不能冒用其他节点。

停用立即禁止新阶段领取，当前租约仍能续期与交付。轮换立即使旧凭据失效，需更新节点私有配置并重启代理；失联租约由现有代次恢复机制回收。节点凭据和本机引擎凭据互相独立，均不包含数据库、R2 或供应商权限。

## 服务端通用配置

后台默认使用表单编辑，可切换 JSON 文本；两种视图共享同一份配置。格式、未知字段或范围无效时保留原输入并阻止切换／保存。默认值、范围和全部 16 种语言由管理员 `GET /v1/admin/compute-nodes/config-schema` 提供。语言支持多选、全选和清空；显式覆盖至少选择一种，勾选「使用节点本地语言设置」则移除覆盖。

公共提交、节点语言配置和报告遇到不支持的语言，返回 HTTP 422、`error.code=LANGUAGE_UNSUPPORTED`；AI 重绘对未开放的语言也返回此错误。其他无效节点字段返回 `NODE_CONFIG_INVALID`，配置版本冲突为 `NODE_CONFIG_CONFLICT`。

数据库保存 `desired_config`、单调递增 `config_version`、`applied_config_version`、脱敏应用错误与实际引擎配置。保存携带 `expected_version`，冲突返回 409。如下配置可直接用于后台创建，省略项由服务端补齐：

```json
{
  "schema_version": 1,
  "execution_slots": 2,
  "poll_seconds": 1,
  "heartbeat_seconds": 10,
  "config_poll_seconds": 15,
  "request_seconds": 30,
  "stage_seconds": 900,
  "input_cache_bytes": 134217728,
  "input_cache_ttl_seconds": 900,
  "engine": {
    "languages": ["zh-Hans", "en"],
    "torch_threads": 4,
    "opencv_threads": 2,
    "cache_bytes": 268435456,
    "cache_ttl_seconds": 900
  }
}
```

| 字段 | 默认与边界 |
| --- | --- |
| `execution_slots` | 1；1–32，服务端强制限制该节点未完成阶段租约数，包括等待回收的过期租约 |
| `poll_seconds` | 1 秒；0.05–30 秒，空闲领取间隔 |
| `heartbeat_seconds` | 10 秒；不超过租约时长的 1/3 |
| `config_poll_seconds` | 15 秒；1–60 秒，且小于服务端节点离线时限 |
| `request_seconds` / `stage_seconds` | 控制 HTTP 30 秒／引擎阶段 900 秒 |
| `input_cache_bytes` / `input_cache_ttl_seconds` | 代理原图缓存 128 MiB／900 秒，0 可禁用 |
| `engine` | 默认 `{}`，字段省略时使用节点本地文件值；显式字段覆盖本地值 |

服务端验证所有字段与范围，拒绝未知字段和不支持的 schema。`engine.languages` 允许当前 16 项目标语言：`zh-Hans`、`zh-Hant`、`ja`、`en`、`ko`、`fr`、`es`、`pt-BR`、`de`、`it`、`ru`、`pl`、`uk`、`tr`、`vi`、`id`。支持语言是目标语言能力，检测／OCR 继续使用既有 48px 模型，不表示已通过相同源语言的 OCR 验收。完整列表和资源限制见[嵌字与 OCR 语言清单](LANGUAGE_SUPPORT.md)。

执行位表示在途阶段，并非模型副本数：代理并发处理网络取图、请求和交付；当前单物理设备图像引擎保留串行模型锁，默认一个执行位。增加位数可增加在途请求，不承诺 GPU 吞吐增加。文本、重绘和上传校验池在后台分别配置执行位，文本／重绘 1–100，上传校验 1–32。`CLUSTER_TEXT_SLOTS`、`CLUSTER_REDRAW_SLOTS`、`CLUSTER_UPLOAD_SLOTS` 仅提供首次创建默认值；数据库设置为后续唯一依据，进程重启不覆盖容量或启停状态。修改对下一次领取生效，缩容不会中止已有租约。

## 拉取与应用顺序

1. 引擎启动读取本地配置、补全并校验所声明语言资源、加载模型和预热；全部成功才报告 ready。
2. 代理用预建身份报告设备，拉取当前完整配置。注册不会改变后台启用状态或执行位。
3. 代理周期拉取配置，即使阶段仍在执行也继续拉取。版本变更后停止新领取，等待所有当前线程完成阶段与结果交付。
4. 代理向本机引擎发送配置覆盖。引擎先准备语言资源，再在设备锁内应用线程、字典与缓存配置；准备失败保留原完整运行配置。
5. 引擎返回实际配置与语言，代理上报服务端；服务端核对当前版本和覆盖值，确认后才允许按新执行位继续领取。
6. 缩容不撤销运行中租约；配置未应用、失败、陈旧或节点停用时不派新工作。失败只记录固定错误码，周期重试，不记录异常中的私有内容。

代理还比对引擎实例 ID 与实际运行配置；引擎独立重启或配置漂移后重新同步，不会把丢失的内存配置继续标为有效。语言路由按节点确认应用后的列表筛选；引擎也拒绝未启用的目标语言。

移除语言后，该语言的待执行阶段等待其他支持节点，不改写任务目标语言或已保存的检查点。

控制池的执行位与供应商限制相互独立：扩大重绘池不会绕过供应商并发上限，扩大文本池不会绕过 RPM、重试次数或处理时限。

## 本地文件与性能参数

- 代理：复制 [node.example.json](../services/compute-agent/node.example.json) 为私有文件，通过 `NODE_CONFIG_FILE` 指定。文件只含控制地址、节点身份和本机引擎连接；执行位与公共轮询参数来自服务端。
- NVIDIA：[engine.cuda.example.json](../services/classic-engine/engine.cuda.example.json)。AMD：[engine.directml.example.json](../services/classic-engine/engine.directml.example.json)。通过 `ENGINE_CONFIG_FILE` 指定。相对路径按配置文件目录解析，移动示例后须调整路径。
- `runtime.languages` 声明启动支持列表；缺失／损坏的所需字典及许可证文件自动下载并按固定长度、SHA-256 校验，原子写入模型缓存；完整文件复用。中日韩不需断词字典；土耳其语、越南语、印尼语采用按词换行。新增语言的 Noto Sans 字体和许可证也在接单前准备并校验。下载失败不接单，翻译过程中不下载。来源与许可见[字典说明](HYPHENATION_DICTIONARIES.md)。
- `runtime.torch_threads`、`runtime.opencv_threads`、缓存大小和 TTL 可由服务端覆盖并热更新。AMD LaMa 子进程在后续裁剪调用中使用更新后的线程值。
- `torch_interop_threads`、`inpaint_workers`、设备、路径属于本机启动参数，修改文件后重启引擎。DirectML 支持 1／2 个 LaMa 裁剪进程，CUDA／CPU 当前为 1。修改 DirectML 裁剪进程数会改变引擎版本，控制服务必须配置匹配版本。
- 一个物理设备共用锁目录；不要通过多个代理复制同一设备容量。配置文件必须只交给部署该节点的操作者，私有文件不提交到仓库。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /v1/admin/compute-nodes` | 管理员创建，返回一次性明文凭据 |
| `GET/PUT /v1/admin/compute-nodes/{id}/config` | 查看／带 expected_version 保存配置与启用状态 |
| `POST /v1/admin/compute-nodes/{id}/rotate-credential` | 轮换凭据 |
| `POST /internal/nodes/register` | 已认证节点报告实际设备能力 |
| `GET /internal/nodes/{id}/config` | 周期拉取配置与节点心跳 |
| `POST /internal/nodes/{id}/config/applied` | 确认版本、实际引擎配置与语言，或固定错误码 |
| `POST /internal/nodes/{id}/claim` | 带 config_version 领取；服务端核对配置与容量 |
| `POST <engine>/internal/config` | 独立引擎凭据保护，仅应用白名单性能／语言字段 |

租约输入、心跳和完成协议仍校验节点身份与执行代次。模型配置、缓存身份、供应商成本计量及用户额度沿用现有独立边界。
