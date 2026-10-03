<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/extension/src/assets/brand/logo-horizontal-zh-dark.webp">
  <img src="apps/extension/src/assets/brand/logo-horizontal-zh-light.webp" width="460" alt="NodeLane 漫译 · NodeLane Comics">
</picture>

**简体中文** | [English](README_EN.md)

**在浏览器里发现、整理和阅读漫画，随时接着上次的进度看。**

[![官网与下载](https://img.shields.io/badge/官网-下载插件-1769B3?style=for-the-badge)](https://comics.nodelane.net/)
[![开发文档](https://img.shields.io/badge/文档-开始开发-334155?style=for-the-badge)](#开始开发)
[![问题反馈](https://img.shields.io/badge/反馈-GitHub_Issues-6855A3?style=for-the-badge)](https://github.com/Wy2926/node-comics/issues)
[![TG 交流群](https://img.shields.io/badge/Telegram-加入交流群-229ED9?style=for-the-badge)](https://t.me/+pPyxB0Sxocw0MDc1)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square)](apps/extension/package.json)
[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square)](apps/extension/package.json)
[![WXT](https://img.shields.io/badge/Extension-WXT-475569?style=flat-square)](apps/extension/README.md)
[![FastAPI](https://img.shields.io/badge/API-FastAPI-009688?style=flat-square)](backend/README.md)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-4169E1?style=flat-square)](backend/README.md)
[![许可证](https://img.shields.io/badge/License-GPL--3.0--only-64748B?style=flat-square)](LICENSE)

</div>

面向 Chrome、Edge、Firefox 的漫画阅读与整理插件。把本地漫画、Google Drive 和已适配网站中的漫画放进书架，查找想看的作品，缓存后离线阅读。

需要翻译时，可开启常规翻译或 AI 重绘，随时对照原图；也可连接本地部署的 [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) 服务。

## 产品体验

- **导入即读**：支持 CBZ / ZIP、CBR / RAR、PDF、无 DRM 的 MOBI / EPUB，以及 Google Drive 和已适配网站。
- **远程书库**：配置多个 OPDS 书库的地址与授权，按需浏览和阅读，无需导入整个目录；支持的资源可离线保存。
- **发现与搜索**：浏览 AniList 趋势、人气、高分和新作，使用作品名称、别名或翻译后的名称搜索已适配网站。
- **整本离线**：缓存网站漫画的全部目录与章节，多选来源语言，查看进度、暂停继续及补齐失败页。
- **按习惯阅读**：连续阅读、单页翻页、阅读方向、缩放与独立阅读背景。
- **按需翻译**：常规翻译与 AI 重绘，支持原图／译图切换、并排对照与阅读位置恢复。
- **自选翻译渠道**：使用官方服务或连接本地 manga-translator-ui；本地渠道无需 NodeLane 账号。
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

| 模块 | 用途与入口 |
| --- | --- |
| [浏览器插件](apps/extension/README.md) | 阅读器、书架、网站适配与翻译交互 |
| [后端](backend/README.md) | API、持久任务、账户、会员与管理后台 |
| [官网](backend/website/README.md) | 16 语介绍、图片翻译、匿名体验、本地历史、下载与账户页面 |
| [Drive 连接页](apps/drive-connect/README.md) | Google 授权与文件选择 |
| [计算节点](services/compute-node/README.md) | Windows 独立包与 Linux NVIDIA 镜像的安装、运行与构建 |
| [图像引擎](services/classic-engine/README.md) | 检测、OCR、LaMa 抹字与嵌字开发 |

各模块 README 提供环境要求和运行命令；验证工具见[脚本入口](scripts/README.md)。

## 开发规范

| 主题 | 文档 |
| --- | --- |
| 产品与阅读 | [产品设计](docs/PRODUCT_DESIGN.md)、[单来源阅读](docs/SIMPLE_COMIC_READING_DESIGN.md)、[整本缓存设计](docs/OFFLINE_CACHE_DESIGN.md) |
| 架构与数据 | [系统架构](docs/ARCHITECTURE.md)、[来源与缓存](docs/COMIC_SOURCE_ARCHITECTURE.md) |
| 翻译与计算 | [翻译契约](docs/READING_TRANSLATION_CONTRACT.md)、[计算协议](docs/COMPUTE_PROTOCOL.md)、[集群架构](docs/TRANSLATION_CLUSTER_DESIGN.md) |
| 网站与界面 | [网站适配](docs/SITE_ADAPTERS.md)、[漫画发现](docs/DISCOVERY.md)、[跨语言搜索设计](docs/COMIC_SEARCH_DESIGN.md)、[界面国际化](docs/UI_INTERNATIONALIZATION.md)、[品牌文案](docs/BRAND_AND_STORE_LISTING.md) |
| 账户与运营 | [会员额度](docs/MEMBERSHIP_AND_QUOTAS.md)、[支付](docs/STRIPE_BILLING.md)、[管理后台](docs/ADMIN_CONSOLE.md)、[GA4 插件使用分析](docs/ANALYTICS.md) |
| 部署与维护 | [部署](docs/DEPLOYMENT.md)、[备份与恢复](docs/OPERATIONS.md)、[代码规范](docs/CODE_QUALITY.md)、[API 契约](contracts/README.md) |

协作要求见 [AGENTS.md](AGENTS.md)。产品规则在所属专题维护，README 不重复定义。

## 许可证

除另有明确声明的第三方内容外，NodeLane Comics 的项目代码采用 **GNU General Public License v3.0 only（SPDX：`GPL-3.0-only`）**，完整条款见 [LICENSE](LICENSE)。本软件不提供任何担保，具体以许可证条款为准。

第三方代码、模型与字体按各自随附的许可使用，原有版权与许可声明继续保留；图像引擎的来源说明见 [THIRD_PARTY.md](services/classic-engine/THIRD_PARTY.md)。漫画内容、封面与用户数据不因本项目的软件许可证而获得授权。
