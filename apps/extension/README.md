# Node Comics 插件

WXT + React + TypeScript，提供桌面浏览器阅读器、单来源书架与网页原位翻译。

## 运行与构建

需要 Node.js 22.23+、npm 10+，在本目录执行：

```powershell
npm ci
npm run dev          # 网页预览，http://127.0.0.1:5173
npm run dev:extension
npm run check
npm test
npm run build        # .output/chrome-mv3
```

Chrome／Edge 在扩展管理页加载对应的 `.output/<browser>-mv3`。网页预览不能替代扩展权限、后台和登录验证。

官方 API 默认由 [service.ts](src/service.ts) 指向产品服务；本地预览沿用该地址。使用隔离后端时，在启动或构建前设置 `VITE_API_BASE`，结束后清除。Drive 构建需要 `VITE_DRIVE_CONNECT_URL`，配置见[连接页](../drive-connect/README.md)。

| 产物 | 命令 |
| --- | --- |
| Chrome 手动安装包 | `npm run zip` |
| Edge 手动安装包 | `npm run zip:edge` |
| Chrome／Edge 商店包 | `npm run zip:chrome:store` / `npm run zip:edge:store` |
| Firefox MV3 审核包 | `npm run zip -- --browser firefox --mv3` |
| 网页预览构建 | `npm run build:web` |

商店包不含 `manifest.key`；Firefox 公开下载使用 AMO 签名 XPI。包校验、上传与发布见[部署规范](../../docs/DEPLOYMENT.md)。

## 开发入口

| 工作 | 规范 |
| --- | --- |
| 网站适配 | [适配器边界与站点入口](../../docs/SITE_ADAPTERS.md) |
| 导入、阅读、缓存与导出 | [来源架构](../../docs/COMIC_SOURCE_ARCHITECTURE.md)、[格式模块](src/comics/formats/README.md)、[导出](../../docs/COMIC_EXPORT_DESIGN.md) |
| 翻译 | [渠道](../../docs/TRANSLATION_CHANNELS.md)、[官方契约](../../docs/READING_TRANSLATION_CONTRACT.md)、[原位翻译](../../docs/IN_PAGE_TRANSLATION.md) |
| UI | [共享主题](../../docs/POPUP_AND_THEME.md)、[国际化](../../docs/UI_INTERNATIONALIZATION.md) |
| 身份与账户 | [身份配置](../../docs/PRODUCTION_IDENTITY.md)、[会员规则](../../docs/MEMBERSHIP_AND_QUOTAS.md) |

浏览器夹具和启动顺序见[脚本入口](../../scripts/README.md)；使用隔离 profile，检查加载、失败、重复操作与阅读位置恢复。
