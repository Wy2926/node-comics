# Comic PASH!

专门封面取自 `img.series-h-img`，缺失时使用作品页 `og:image`；`cdn-public.comici.jp` 按操作申请可选权限，封面无需正文图块还原。

支持 HTTPS `comicpash.jp`／`www.comicpash.jp` 的 `/series/<id>` 作品目录、数字分页及 new／old 排序地址，以及 `/episodes/<id>` 章节。首页、搜索等只认领为非阅读页面，不把封面或推荐图当正文。

- 作品导入：HTTP 读取完整只读目录、按源站顺序阅读、每 12 小时检查更新。授权后在作品页 `.series-act` 嵌入导入／管理按钮；也可在插件中粘贴作品或章节链接导入。
- 章节读取：HTTP 获取完整页序、按需下载并还原原始分辨率图片，不依赖来源标签页。裸章节先通过已有 viewer 元数据解析所属作品，再核对完整目录包含当前章节；弹窗和粘贴链接均复用作品身份。
- 标签页翻译：读取 Comici 正文容器内已渲染 canvas，排除广告、空白、点赞和结束页。窗口快照保持部分状态；完整章节导入使用独立网络通道。尺寸、画布替换／重绘、viewer 身份和导航变化使旧读取失效。
- 安装时不增加必需权限；来源网站、正文 `viewer.comicpash.jp` 权限按用户操作申请，授权后才登记页面入口。

## 来源协议

2026-09-24 核实真实公开响应。目录使用 `/series/<id>/<page>` HTML 的 `series-sort-link` 范围和 `series-eplist-item-link` 条目；当前分页的链接可能指回裸作品 URL，按已验证数字分页地址归一化。检查范围连续、条目数量、重复身份、canonical 归属，并在多页读取后重新核对第一页。失败不发布部分目录或覆盖旧目录。

章节 HTML 提供 `data-comici-viewer-id`、`data-series-id` 与 `/api`；目录生成的章节地址使用本地 `#nodelane-comicpash=<series>` 绑定作品，读取时核对实际归属。`GET /api/book/contentsInfo` 的公开请求带空 `user-id`，先读页数，再读取完整范围，核对总数、sort 连续页序、尺寸、正文主机和 `/book/<viewer-id>/` 归属。签名地址只随来源清单使用，不写入仓库样本或验证报告。

图片使用 4×4、按列枚举的 tile permutation；`image.ts` 经公共图片管线还原为 PNG，匹配网页 viewer 的余边处理。实现依据 [源站 viewer.js](https://comicpash.jp/js/viewer/viewer.js)，当日 SHA-256：`ba9199d3996e4e8feca4d36bfd82e9d185aa7b2310f7b4f3273290bda68fc06a`。只独立实现已观察的协议，不执行或分发源站脚本；无新增第三方解码组件、模型、字体或权重。

目录可列出付费／待免费章节，但不保证可读取。仅处理源站公开提供的完整正文，缺少访问权或协议不符时明确失败，不处理购买、登录或等待解锁。过期图片地址需要重新从源站获取清单；已物化图片按公共缓存策略复用。

## 验证

插件目录执行 `npm run check`、`npm test`、`npm run build`。仓库根目录按[公共脚本环境](../../../../../../scripts/README.md)配置 Playwright 和 Chromium 后：

```powershell
node scripts/verify_comicpash.mjs
$env:RUN_LIVE_COMICPASH = '1'
node scripts/verify_comicpash.mjs
Remove-Item Env:RUN_LIVE_COMICPASH
node scripts/verify_inline_translation.mjs
```

`verify_comicpash` 默认使用隔离目录／接口和自制 tile 图片，检查站内入口、完整导入、实际像素还原、关闭源站取图、重开位置恢复、来源失败及目录重试。真实开关仅读取公开来源，模型和产品 API 不参与；截图和脱敏报告在忽略目录 `artifacts/comicpash-validation/`。

2026-09-24，隔离 Chromium MV3 真实验收：作品 `1fafeeae328df` 完整目录 40 条，首章 `17f11c20955a2` 的 22/22 页均在构建版阅读器取图、还原并显示（720×1024）；关闭源站后继续阅读，重开恢复第 10 页，完整目录刷新通过。已检查正文、入口与恢复截图，没有新增来源采集标签页。原位回归另覆盖合成 RTL 双页、广告排除、恢复原图、事件／几何保持和画布复用。

浏览器预授权隔离 profile；原生权限弹窗、Firefox 现场运行、受限章节和真实翻译模型效果未验证。通过公开样本不代表所有作品及未来协议均已覆盖。

2026-09-25 裸章节回归通过：`17f11c20955a2` 解析到作品 `1fafeeae328df`，取得 40 条完整目录和 22 页正文清单，章节 HTML 只请求一次，无来源标签页。检查期间源站也返回过 HTTP 200 的作品信息获取失败页面（无目录），完整性校验正确拒绝，源站恢复后完整链路通过；未为此放宽校验。合成回归覆盖归属、复用解析、取消和完整目录；运行 `node scripts/verify_chapter_imports.mjs` 可重查实时状态，报告区分归属、目录和正文阶段。该定向回归不重复下载图片。
