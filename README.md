# NodeLane 漫译 · NodeLane Comics

面向 Chrome、Edge、Firefox 的漫画阅读与翻译插件，支持本地漫画文件、Google Drive 和专门适配的网站，提供常规翻译与 AI 重绘。

支持本地翻译，可连接本地部署的 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) 服务。

## 开始开发

| 模块 | 用途与入口 |
| --- | --- |
| [浏览器插件](apps/extension/README.md) | 阅读器、书架、网站适配与翻译交互 |
| [后端](backend/README.md) | API、持久任务、账户、会员与管理后台 |
| [官网](backend/website/README.md) | 五语介绍、下载与账户页面 |
| [Drive 连接页](apps/drive-connect/README.md) | Google 授权与文件选择 |
| [计算节点](services/compute-node/README.md) | Windows 独立节点的安装、运行与构建 |
| [图像引擎](services/classic-engine/README.md) | 检测、OCR、LaMa 抹字与嵌字开发 |

各模块 README 提供环境要求和运行命令；验证工具见[脚本入口](scripts/README.md)。

## 开发规范

| 主题 | 文档 |
| --- | --- |
| 产品与阅读 | [产品设计](docs/PRODUCT_DESIGN.md)、[单来源阅读](docs/SIMPLE_COMIC_READING_DESIGN.md) |
| 架构与数据 | [系统架构](docs/ARCHITECTURE.md)、[来源与缓存](docs/COMIC_SOURCE_ARCHITECTURE.md) |
| 翻译与计算 | [翻译契约](docs/READING_TRANSLATION_CONTRACT.md)、[计算协议](docs/COMPUTE_PROTOCOL.md)、[集群调度](docs/TRANSLATION_CLUSTER_DESIGN.md) |
| 网站与界面 | [网站适配](docs/SITE_ADAPTERS.md)、[跨语言搜索设计](docs/COMIC_SEARCH_DESIGN.md)、[界面国际化](docs/UI_INTERNATIONALIZATION.md)、[品牌文案](docs/BRAND_AND_STORE_LISTING.md) |
| 账户与运营 | [会员额度](docs/MEMBERSHIP_AND_QUOTAS.md)、[支付](docs/STRIPE_BILLING.md)、[管理后台](docs/ADMIN_CONSOLE.md) |
| 部署与维护 | [部署](docs/DEPLOYMENT.md)、[备份与恢复](docs/OPERATIONS.md)、[代码规范](docs/CODE_QUALITY.md)、[API 契约](contracts/README.md) |

协作要求见 [AGENTS.md](AGENTS.md)。产品规则在所属专题维护，README 不重复定义。
