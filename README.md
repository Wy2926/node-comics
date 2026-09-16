# Node Comics

2026-09-16 部署更新：服务端已容器化部署至现有美国 VPS，复用线上 PostgreSQL；本机 RTX 4060 作为独立计算节点。入口、镜像、运行命令与验证边界见[美国 VPS 部署](docs/VPS_DEPLOYMENT.md)。以下“未公开部署”描述属于此前实现阶段记录。

2026-09-16：已加入生产身份校验、公钥撤销、提交反滥用、共享原图/已完成译图复用、监控与隔离恢复；移除一天后无引用对象删除。新空库基线 `shared_0001`，不兼容旧数据。状态和验证见[本轮修复](docs/PRODUCTION_FIXES.md)，未公开部署。

同日补充：已修复慢上传持有数据库连接、并发领取嵌套连接和反馈无预算，并新增后台“系统设置”，统一维护上传并发、超时及反馈预算。当前迁移头为 `shared_0003_system_settings`，可从 `shared_0001` 增量升级。生效规则及验证见[系统设置](docs/SYSTEM_SETTINGS.md)。

二次元风格的漫画阅读与翻译浏览器插件，Chrome / Edge Manifest V3。

2026-09-15：已完成双模式持久队列和集群阶段调度重构。每种模式分别提供普通 10／PLUS 500 页在途容量，实时名额普通 2／PLUS 10；实时与预存分级，同级会员权重默认 2 倍、可配置，空闲执行位可借用。原图和译图存私有 R2，默认无限期保留；客户端发送阅读顺序，服务器持续消费。见[实现说明](docs/TRANSLATION_CLUSTER_DESIGN.md)与[验证边界](docs/CLUSTER_VALIDATION.md)。代码完成不代表已切换现有服务或公开部署。

会员规则保留普通每日 100 页常规、PLUS 常规不限量和每会员月 300 页重绘，支持限时赠送。无固定共享用户并发、旧 preview/batch 或 Celery 队列兼容；新部署使用独立 `shared_0001` 数据库。

2026-09-16：相同原图按内容跨账户免重复上传，已完成且模式 / 语言 / 配置相同的译图可免费复用；账户授权、任务和历史保持私有。已移除按一天期限扫描删除无引用对象的逻辑。生产身份、提交限流、健康监控与备份恢复说明见[生产身份](docs/PRODUCTION_IDENTITY.md)、[提交限制](docs/SUBMISSION_SCHEDULING.md)及[运维说明](docs/OPERATIONS.md)。

2026-09-14 范围更新：保留 AI 图片重绘翻译，新增常规翻译需求（文字检测／OCR、LLM 文本翻译、LaMa 局部抹字与嵌字）。用户同意 LaMa，以及低成本 LLM 在次数和处理时限内自动重试（成本仅计量，不设页成本上限）。常规模式已基于[开源方案与成本调研](docs/CLASSIC_TRANSLATION_RESEARCH.md)实现，启动与验证见[常规翻译运行说明](docs/CLASSIC_IMPLEMENTATION.md)。

阅读器支持“常规翻译”和“AI 重绘翻译”。前者使用独立 OCR／LaMa 引擎与文本 LLM，后者保留 OpenAI 兼容 `POST /v1/images/edits` 多供应商接口；Key 留在后端。

客户端已更新为大封面书架与独立阅读器，支持两种卡片排列、缩略图目录、自动翻译与查看、最新效果、反馈重译、分组记录及用量统计。新接口和本地 API 更新方法见 [UI 实现说明](docs/UI_IMPLEMENTATION.md)。

作品详情页支持[导出漫画](docs/COMIC_EXPORT_DESIGN.md)：按副本生成 CBZ、图片 ZIP 或 PDF，原图与译图分别成册，未译页可用原图补齐。导出前检查缺页和范围，多份结果打包下载。

本地支持图片、未加密 MOBI、CBZ/ZIP、CBR/RAR 和 PDF，边界见[格式与缓存说明](docs/IMPORT_FORMATS_AND_CACHE.md)。本地导入建立文件 SHA-256 与原始页索引，同一账户在另一台电脑重新导入相同文件，可恢复保留期内的译图和进行中任务；重新打包的相同原图也可按页 SHA-256 免上传恢复。前端上传／下载并发默认 2、可设 1–10；后台按每模式容量、阅读优先级和用户权重独立调度。

2026-09-16：后台可添加独立身份节点，服务端执行位与版本化配置自动同步；语言资源启动补全、线程与缓存参数可声明。见[节点配置](docs/NODE_CONFIGURATION.md)与[NVIDIA 实测](docs/NVIDIA_GPU_VALIDATION.md)。

同日更新：后台配置支持表单／JSON 和 16 语言多选，三个控制池执行位可修改；文本成本仅计量。常规嵌字已整体接入固定版本 Manga Translator UI 的 Qt 自动排版，支持气泡内重排、中日横竖排与西文断词，保留 BallonsTranslator 气泡提取和未识别文字保护。新引擎已完成本地与容器验证，现有运行集群尚未切换；版本、图片对照和历史部署记录见[气泡与嵌字说明](docs/LETTERING_LAYOUT.md)。

## 本地运行

英文嵌字字典重复下载已修复；指定语言预下载、离线校验及执行位说明见[嵌字字典准备](docs/HYPHENATION_DICTIONARIES.md)。

Windows AMD RX 6900 XT 可运行 `./scripts/start-local-amd.ps1`；首次安装加 `-Setup`，一页完整翻译验证加 `-Smoke`。此原模型 DirectML 路径使用本地进程，配置与同图验收见 [AMD GPU 说明](docs/AMD_GPU_VALIDATION.md)。

本机 NVIDIA RTX 4060 Laptop GPU 已跑通 `./scripts/start-local-nvidia.ps1 -Smoke`，首次安装加 `-Setup`。

启用常规翻译使用 `./scripts/bootstrap.ps1 -Start -Classic`，并按常规翻译说明配置文本接口。

环境：Docker Desktop、Node.js 22、npm；在 `.env` 填私有 R2、文本与图片模型配置，模板见 [.env.example](.env.example)。

```powershell
./scripts/bootstrap.ps1 -Start
cd apps/extension
npm ci
npm run dev
```

阅读器：[本地预览](http://127.0.0.1:5173)，API：[接口文档](http://127.0.0.1:18088/docs)。上述命令是开发入口，`deploy/.env.local` 显式设置 `APP_ENV=development`；端口被占用时修改 `API_PORT`。新 `shared_0001` 基线必须使用空数据库，已有旧版本数据库需另选全新 Compose 项目 / 数据库，不自动迁移或清空。公开环境使用独立生产配置与 `-Production` 引导，强制关闭 DEV_AUTH 并验证 OIDC，见[生产身份说明](docs/PRODUCTION_IDENTITY.md)。

```powershell
npm run check
npm test
npm run build
npm run build:web
```

Chrome／Edge 扩展管理页加载 `apps/extension/.output/chrome-mv3`。浏览器预览用于本地导入阅读，网页采集需要加载插件。

## 文档

常规翻译的全部语言候选、当前开放范围、字体缺字与 OCR 能力边界见[嵌字与 OCR 语言清单](docs/LANGUAGE_SUPPORT.md)。

| 文档 | 内容 |
| --- | --- |
| [产品设计](docs/PRODUCT_DESIGN.md) | 产品流程、范围与验收 |
| [会员与翻译额度设计](docs/MEMBERSHIP_AND_QUOTAS.md) | 普通／PLUS 已实现规则、会员月额度、限时赠送与旧计费替换范围 |
| [翻译集群与队列设计](docs/TRANSLATION_CLUSTER_DESIGN.md) | 已实现：每模式 10/500 在途、2/10 实时、双队列、可配置权重、公平借用、R2 长期保留与多机计算 |
| [通用漫画作品管理设计](docs/COMIC_LIBRARY_DESIGN.md) | 已确认；作品、章节、出版套系、卷册、收录关系与来源副本，首轮已实现 |
| [MangaCopy 来源适配与导入设计](docs/MANGACOPY_LIBRARY_DESIGN.md) | 已实现详情页范围导入、JS 图片清单与有序采集，映射通用作品模型 |
| [阅读目录与插件译本](docs/READER_DIRECTORY_AND_EDITIONS.md) | 整部作品目录、已有翻译的派生阅读视图与有序采集 |
| [作品管理实现与验收](docs/COMIC_LIBRARY_IMPLEMENTATION.md) | 新数据库、旧逻辑清理、操作说明、真实来源与浏览器验收边界 |
| [客户端 UI 重设计草案](docs/UI_REDESIGN_PROPOSAL.md) | 大卡片书架、简洁阅读器、翻译记录、用量统计与多主题（待评审） |
| [架构设计](docs/ARCHITECTURE.md) | 插件、任务、权限与供应商 |
| [服务端管理后台](docs/ADMIN_CONSOLE.md) | React 管理页面、用户与节点、队列积压、逐页耗时与执行履历、构建和登录 |
| [技术验证](docs/TECH_RESEARCH.md) | 协议依据、样本与验证边界 |
| [常规翻译调研](docs/CLASSIC_TRANSLATION_RESEARCH.md) | 开源引擎比较、LaMa、LLM 成本与重试、待实施验证 |
| [运行与实现](docs/IMPLEMENTATION.md) | 操作命令、配置、交付状态及限制 |
| [代码规范与模块维护](docs/CODE_QUALITY.md) | 模块边界、冗余清理、自动检查与本轮验证 |

用户漫画位于被忽略的 `临时资源/`，提取结果在 `private-test-data/`。发布示例只包含项目生成的原创图片。支付订阅、长期云书架、长图分段和其他电子书格式属于后续范围。
