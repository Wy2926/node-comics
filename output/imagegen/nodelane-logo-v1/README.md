# NodeLane 漫译 / NodeLane Comics Logo v1

2026-09-20，设计资产交付。已完成图片生成、官网横版排版和插件尺寸导出；尚未接入产品、发布或部署。

## 设计

漫画对白框承载白色 N 字母，左下的短尾表达对白与翻译，右上的粉色折页表达漫画阅读。蓝色与深墨色延续项目现有界面，粉色作为小面积点缀。插件使用纯图形，官网使用图形与产品名称的横向组合。

品牌配色参考：蓝色 `#1769B3`、深墨色 `#202D43`、粉色 `#E879A4`。AI 原图存在轻微色彩变化，这些数值是排版与界面的配色参考，不表示原图每个像素均为固定色值。

## 文件

| 文件 | 用途 |
| --- | --- |
| `brand-preview.png` | 1600×1080 设计预览，包含深浅背景与实际尺寸图标 |
| `logo-mark-1024.png` / `.webp` | 1024×1024 透明底主图形 |
| `icon-16.png`、`icon-24.png`、`icon-32.png`、`icon-48.png`、`icon-64.png`、`icon-128.png`、`icon-256.png`、`icon-512.png` | 插件工具栏、扩展管理、商店与高分辨率展示 |
| `logo-horizontal-zh-light.png` / `.webp` | 中文官网横版，浅色背景使用 |
| `logo-horizontal-zh-dark.png` / `.webp` | 中文官网横版，深色背景使用 |
| `logo-horizontal-en-light.png` / `.webp` | 英文官网横版，浅色背景使用 |
| `logo-horizontal-en-dark.png` / `.webp` | 英文官网横版，深色背景使用 |
| `favicon.ico` | 含 16、32、48、128、256 像素的透明图标 |
| `generated-master.png` | 接口实际返回的原始图片，保留备查 |
| `prompt.txt` | 完整生成提示词，不含凭据 |
| `asset-manifest.json` | 请求参数、实际尺寸、后处理说明、输出尺寸与 SHA-256 |
| `export-assets.mjs` | 可重复的本地排版、导出与尺寸校验脚本 |

横版文件均为 1600×320 透明底。`light` / `dark` 指适用的页面背景，文件本身没有铺底色。请按原比例显示，避免拉伸；例如官网横版宽 240 px、高 48 px。所有交付图形均为位图，不包含可编辑矢量路径。

## 生成与处理

- 按用户指定接口 `https://sub2api.nodelane.net/v1/images/generations` 调用 `gpt-image-2`，使用 imagegen 技能的内置 CLI，`quality=high`。
- 请求尺寸为 1536×1536，服务实际返回 1254×1254 RGBA PNG，且已有透明背景；未执行绿幕抠图。
- 保留原始生成文件。导出时仅清除 alpha ≤ 8 的近透明杂点，将 alpha ≥ 248 归一为不透明，再裁切、留白和缩放。
- 官网产品名在本地独立排版，使用系统已有的 Segoe UI / Microsoft YaHei，仅交付栅格化文字，不分发字体文件。
- 密钥仅通过调用进程的环境变量使用；生成提示词、导出脚本及交付包均不保存凭据。

## 复现与验证

仓库官网依赖已经安装时，在仓库根目录执行：

```powershell
node output/imagegen/nodelane-logo-v1/export-assets.mjs
```

脚本复用 `backend/website/node_modules` 中的 Sharp 0.35.4，依赖 Windows 系统字体；字体环境变化会影响横版排版。命令仅在本地导出，不调用生图接口。

已检查预览图中的浅色背景、深色背景、中文名称、英文名称及 16/24/32/48/64 像素实际展示；已校验所有图标尺寸和透明通道。原图、完整提示词及参数均保留在此目录。

接入时，扩展 manifest 的 `icons` 可分别引用 16、32、48、128 像素文件，`action.default_icon` 可引用 16、24、32 像素文件。浏览器实际加载验证应随接入改动完成。
