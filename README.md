# Node Comics

二次元风格的漫画阅读与翻译浏览器插件，Chrome / Edge Manifest V3。

2026-09-14 范围更新：保留 AI 图片重绘翻译，新增常规翻译需求（文字检测／OCR、LLM 文本翻译、LaMa 局部抹字与嵌字）。用户同意 LaMa，以及低成本 LLM 在预算内自动重试。常规模式已基于[开源方案与成本调研](docs/CLASSIC_TRANSLATION_RESEARCH.md)实现，启动与验证见[常规翻译运行说明](docs/CLASSIC_IMPLEMENTATION.md)。

阅读器支持“常规翻译”和“AI 重绘翻译”。前者使用独立 OCR／LaMa 引擎与文本 LLM，后者保留 OpenAI 兼容 `POST /v1/images/edits` 多供应商接口；Key 留在后端。

客户端已更新为大封面书架与独立阅读器，支持两种卡片排列、缩略图目录、自动翻译与查看、最新效果、反馈重译、分组记录及用量统计。新接口和本地 API 更新方法见 [UI 实现说明](docs/UI_IMPLEMENTATION.md)。

本地支持图片、未加密 MOBI、CBZ/ZIP、CBR/RAR 和 PDF，边界见[格式与缓存说明](docs/IMPORT_FORMATS_AND_CACHE.md)。本地导入建立文件 SHA-256 与原始页索引，同一账户在另一台电脑重新导入相同文件，可恢复保留期内的译图和进行中任务；重新打包的相同原图也可按页 SHA-256 免上传恢复。前端上传／下载并发默认 2、可设 1–10；后端按用户轮转并限制每用户同时占用的执行名额，多个批次与翻译模式共用该用户限额。详见[运行与实现](docs/IMPLEMENTATION.md#文件匹配与并发)。

## 本地运行

启用常规翻译使用 `./scripts/bootstrap.ps1 -Start -Classic`，并按常规翻译说明配置文本接口。

环境：Docker Desktop、Node.js 22、npm；在 `.env` 填图片模型配置，模板见 [.env.example](.env.example)。

```powershell
./scripts/bootstrap.ps1 -Start
cd apps/extension
npm ci
npm run dev
```

阅读器：[本地预览](http://127.0.0.1:5173)，API：[接口文档](http://127.0.0.1:18088/docs)。默认本地测试登录，Docker 数据与其他项目隔离。公开环境必须关闭 DEV_AUTH 并配置 OIDC。

```powershell
npm run check
npm test
npm run build
npm run build:web
```

Chrome／Edge 扩展管理页加载 `apps/extension/.output/chrome-mv3`。浏览器预览用于本地导入阅读，网页采集需要加载插件。

## 文档

| 文档 | 内容 |
| --- | --- |
| [产品设计](docs/PRODUCT_DESIGN.md) | 产品流程、范围与验收 |
| [通用漫画作品管理设计](docs/COMIC_LIBRARY_DESIGN.md) | 已确认；作品、章节、出版套系、卷册、收录关系与来源副本，首轮已实现 |
| [MangaCopy 来源适配与导入设计](docs/MANGACOPY_LIBRARY_DESIGN.md) | 已实现详情页范围导入与 data-src 采集，映射通用作品模型 |
| [作品管理实现与验收](docs/COMIC_LIBRARY_IMPLEMENTATION.md) | 新数据库、旧逻辑清理、操作说明、真实来源与浏览器验收边界 |
| [客户端 UI 重设计草案](docs/UI_REDESIGN_PROPOSAL.md) | 大卡片书架、简洁阅读器、翻译记录、用量统计与多主题（待评审） |
| [架构设计](docs/ARCHITECTURE.md) | 插件、任务、权限与供应商 |
| [技术验证](docs/TECH_RESEARCH.md) | 协议依据、样本与验证边界 |
| [常规翻译调研](docs/CLASSIC_TRANSLATION_RESEARCH.md) | 开源引擎比较、LaMa、LLM 成本与重试、待实施验证 |
| [运行与实现](docs/IMPLEMENTATION.md) | 操作命令、配置、交付状态及限制 |
| [代码规范与模块维护](docs/CODE_QUALITY.md) | 模块边界、冗余清理、自动检查与本轮验证 |

用户漫画位于被忽略的 `临时资源/`，提取结果在 `private-test-data/`。发布示例只包含项目生成的原创图片。支付订阅、长期云书架、长图分段和其他电子书格式属于后续范围。
