# 浏览器插件

WXT、React、TypeScript。需要 Node.js 22.12+；命令在本目录运行。

```sh
npm ci
npm run dev                 # 网页调试，127.0.0.1:5173
npm run dev:extension       # 扩展调试
npm run check
npm test
npm run build               # Chrome MV3
npm run zip:chrome:store
npm run zip:edge:store
npx wxt zip --browser firefox --mv3
```

`VITE_API_BASE` 指定 API，`VITE_DRIVE_CONNECT_URL` 指定 Drive 连接页。正式构建前核对地址；浏览器本机翻译可独立使用。

弹窗识别到通用作品目录时，点「添加到书架」保存完整目录；在章节页点「临时阅读本章（不入书架）」可直接用扩展阅读器打开。「漫画网站 → 通过链接添加漫画」也接受这两种链接。

## 代码入口

| 目录 | 职责 |
| --- | --- |
| `src/comics`、`src/storage` | 漫画、导入、字节缓存与进度 |
| `src/reader` | 阅读窗口与交互 |
| `src/sources` | 站点发现、目录与取图 |
| `src/discovery` | [作品关联、资料站适配与公开评论](../../docs/WORK_LINKS.md) |
| `src/translation` | 渠道、任务与结果 |
| `src/ui`、`src/i18n` | 通用界面与字典 |
| `../../shared` | 本仓库使用的图像协议、模型和字体数据 |

单元测试在 `tests/` 和源码模块旁。浏览器验证入口见[辅助脚本](../../scripts/README.md)；需要扩展权限的用例使用构建后的 MV3。

官网站点清单更新：`node scripts/export-website-catalog.mjs <新输出目录>`，将产物替换后端仓库的 `contracts/extension/`。普通构建不访问其他仓库。

[站点规则](../../docs/SITE_ADAPTERS.md) · [翻译规则](../../docs/TRANSLATION.md) · [Shinobu 来源](third_party/shinobu/THIRD_PARTY_NOTICES.md)
