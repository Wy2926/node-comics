<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/extension/src/assets/brand/logo-horizontal-zh-dark.webp">
  <img src="apps/extension/src/assets/brand/logo-horizontal-zh-light.webp" width="460" alt="NodeLane 漫译 · NodeLane Comics">
</picture>

**简体中文** | [English](README_EN.md)

**在浏览器里读漫画、翻译图片，随时接着上次的进度看。**

[![官网与下载](https://img.shields.io/badge/官网-下载插件-1769B3?style=for-the-badge)](https://comics.nodelane.net/)
[![问题反馈](https://img.shields.io/badge/反馈-GitHub_Issues-6855A3?style=for-the-badge)](https://github.com/Wy2926/node-comics/issues)
[![TG 交流群](https://img.shields.io/badge/Telegram-加入交流群-229ED9?style=for-the-badge)](https://t.me/+pPyxB0Sxocw0MDc1)

[![许可证](https://img.shields.io/badge/License-GPL--3.0--only-64748B?style=flat-square)](LICENSE)

</div>

适用于 Chrome、Edge、Firefox。把本地文件、Google Drive 和已适配网站的漫画放进书架，边看边译，随时对照原图。

在设置中选择「浏览器本地翻译（Beta）」，下载模型和字体后即可使用，无需部署服务。图片留在本机，识别文字发送到所选翻译服务；也可使用官方翻译或连接自建 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui)。

## 产品体验

- **导入即读**：打开常见漫画与电子书文件，也可连接 Google Drive、OPDS 书库或导入已适配网站。
- **找漫画更方便**：浏览榜单、按名称搜索支持的网站；网站目录提供分类筛选。
- **按习惯阅读**：连续滚动、单页或双页翻页，自选方向、缩放和背景，用书签记住喜欢的页面。
- **随读随译**：在阅读器或网页中翻译图片，切回原图或并排对照，保留阅读位置。
- **离线续读**：提前缓存支持的网站漫画，随时暂停、继续或重试失败页。
- **界面随你调整**：16 种界面语言、六种主题色、亮暗外观与文字大小。

### 我的漫画

导入、搜索和管理漫画，继续上次阅读。

![漫画书架与阅读进度](docs/images/library.png)

<details>
<summary>查看漫画发现、网站搜索、离线缓存、阅读目录与翻译对照</summary>

### 发现漫画

浏览榜单，查看简介、评分与别名，再查找可阅读的网站来源。

![漫画发现与作品详情](docs/images/discovery.png)

### 搜索漫画

按作品名称或别名搜索，也可先翻译名称；选择网站、查看候选结果，确认后导入阅读。

![漫画名称、网站选择与搜索结果](docs/images/cross-language-search.png)

### 离线中心

管理网站漫画的缓存任务，查看章节进度与空间占用，随时暂停或继续。缓存完成的章节可离线阅读。

![离线缓存任务、章节进度与空间占用](docs/images/offline-center.png)

### 阅读与目录

在阅读器中浏览章节目录，查看语言选项、页数、缓存和阅读状态。

![阅读器与展开的多语言章节目录](docs/images/reader-directory.png)

### 原图与译图对照

需要翻译时再开启，可并排查看原图和译图，也可切回原图继续阅读。

![原图与中文译图并排对照](docs/images/translation-comparison.png)

</details>

以上为用户提供的产品截图，漫画内容与封面版权归各自权利人所有。

## 交流与反馈

加入 [Telegram 交流群](https://t.me/+pPyxB0Sxocw0MDc1)，讨论使用体验与功能建议。遇到问题可提交 [GitHub Issue](https://github.com/Wy2926/node-comics/issues)，附上浏览器版本、复现步骤与必要截图。

## 开始开发

<details>
<summary>模块入口与开发文档</summary>

| 模块 | 用途与入口 |
| --- | --- |
| [浏览器插件](apps/extension/README.md) | 阅读器、书架、网站适配与翻译交互 |
| [后端](backend/README.md) | API、持久任务、账户、会员与管理后台 |
| [官网](backend/website/README.md) | 17 语介绍、图片翻译、匿名体验、本地历史、下载与账户页面 |
| [Drive 连接页](apps/drive-connect/README.md) | Google 授权与文件选择 |
| [计算节点](services/compute-node/README.md) | Windows 独立包与 Linux NVIDIA 节点的部署、运行与构建 |
| [图像引擎](services/classic-engine/README.md) | 检测、OCR、LaMa 抹字与嵌字开发 |

各模块 README 提供环境要求和运行命令；验证工具见[脚本入口](scripts/README.md)。

### 开发规范

| 主题 | 文档 |
| --- | --- |
| 产品与阅读 | [产品设计](docs/PRODUCT_DESIGN.md)、[单来源阅读](docs/SIMPLE_COMIC_READING_DESIGN.md)、[整本缓存设计](docs/OFFLINE_CACHE_DESIGN.md) |
| 架构与数据 | [系统架构](docs/ARCHITECTURE.md)、[来源与缓存](docs/COMIC_SOURCE_ARCHITECTURE.md) |
| 翻译与计算 | [翻译契约](docs/READING_TRANSLATION_CONTRACT.md)、[整本文件翻译](docs/DOCUMENT_TRANSLATION.md)、[模型选择设计](docs/TRANSLATION_MODEL_SELECTION_DESIGN.md)、[计算协议](docs/COMPUTE_PROTOCOL.md)、[集群架构](docs/TRANSLATION_CLUSTER_DESIGN.md) |
| 网站与界面 | [网站适配](docs/SITE_ADAPTERS.md)、[漫画发现](docs/DISCOVERY.md)、[跨语言搜索设计](docs/COMIC_SEARCH_DESIGN.md)、[界面国际化](docs/UI_INTERNATIONALIZATION.md)、[品牌文案](docs/BRAND_AND_STORE_LISTING.md) |
| 账户与运营 | [会员额度](docs/MEMBERSHIP_AND_QUOTAS.md)、[支付](docs/STRIPE_BILLING.md)、[管理后台](docs/ADMIN_CONSOLE.md)、[GA4 插件使用分析](docs/ANALYTICS.md) |
| 部署与维护 | [部署](docs/DEPLOYMENT.md)、[备份与恢复](docs/OPERATIONS.md)、[代码规范](docs/CODE_QUALITY.md)、[API 契约](contracts/README.md) |

协作要求见 [AGENTS.md](AGENTS.md)。产品规则在所属专题维护，README 不重复定义。

</details>

## 许可证

除另有明确声明的第三方内容外，NodeLane Comics 的项目代码采用 **GNU General Public License v3.0 only（SPDX：`GPL-3.0-only`）**，完整条款见 [LICENSE](LICENSE)。本软件不提供任何担保，具体以许可证条款为准。

第三方代码、模型与字体按各自随附的许可使用，原有版权与许可声明继续保留；图像引擎的来源说明见 [THIRD_PARTY.md](services/classic-engine/THIRD_PARTY.md)。漫画内容、封面与用户数据不因本项目的软件许可证而获得授权。
