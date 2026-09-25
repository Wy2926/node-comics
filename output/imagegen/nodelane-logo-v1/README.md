# NodeLane 品牌素材

漫画对白框、N 字母与粉色折页组成品牌图形。浅／深背景横版分别提供中文和英文名称；按原比例使用。

| 文件 | 用途 |
| --- | --- |
| `logo-mark-1024.*` | 透明主图形 |
| `icon-*.png` / `favicon.ico` | 浏览器与商店图标 |
| `logo-horizontal-<zh|en>-<light|dark>.*` | 1600 × 320 横版标识 |
| `generated-master.png` / `prompt.txt` | 生成源图和提示词 |
| `asset-manifest.json` / `export-assets.mjs` | 素材来源、摘要和导出工具 |

在仓库根目录运行 `node output/imagegen/nodelane-logo-v1/export-assets.mjs` 可重新导出；需要官网 Sharp 依赖与 Windows 系统字体，不调用图片接口。

产品使用 `apps/extension/public/brand`、`apps/extension/src/assets/brand` 和官网内的资源副本，构建不读取本目录。名称与文案见[品牌规范](../../../docs/BRAND_AND_STORE_LISTING.md)。
