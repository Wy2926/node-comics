# Node Comics

二次元风格的漫画阅读与 AI 图片翻译浏览器插件，Chrome / Edge Manifest V3。

2026-09-13 用户最终范围：翻译全部通过后端图片模型完成，只有“AI 翻译”入口。后端接 OpenAI 兼容 `POST /v1/images/edits`，多供应商配置，Key 留在后端。

## 本地运行

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
| [架构设计](docs/ARCHITECTURE.md) | 插件、任务、权限与供应商 |
| [技术验证](docs/TECH_RESEARCH.md) | 协议依据、样本与验证边界 |
| [运行与实现](docs/IMPLEMENTATION.md) | 操作命令、配置、交付状态及限制 |

用户漫画位于被忽略的 `临时资源/`，提取结果在 `private-test-data/`。发布示例只包含项目生成的原创图片。支付订阅、长期云书架、长图分段和其他电子书格式属于后续范围。
