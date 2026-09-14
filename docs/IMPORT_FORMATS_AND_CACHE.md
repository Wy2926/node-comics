# 本地格式与翻译缓存

2026-09-14：已实现 CBZ/ZIP、CBR/RAR、PDF 导入及按页内容摘要恢复。保留图片与 MOBI。前后端需要配套更新；本次未更新正在运行的产品 API、未公开部署。

## 格式范围

| 格式 | 读取与顺序 | 当前边界 |
| --- | --- | --- |
| PNG / JPEG / WebP | 多图按自然文件名排序 | 沿用独立图片导入限制，最多 300 张 |
| 未加密 MOBI | MOBI6 / MOBI6+KF8，按正文图片引用顺序 | 512 MiB、1500 页；独立 KF8/AZW3、HUFF/CDIC、DRM 不支持 |
| CBZ / ZIP | ZIP Store / Deflate，按完整路径自然排序；忽略隐藏文件、`__MACOSX` 和非图片项 | 512 MiB、1500 页、10000 个目录项；展开最多 1024 MiB，单项 32 MiB；不支持加密、分卷 |
| CBR / RAR | UnRAR 解码，支持 RAR4 / RAR5；按自然路径排列，固实包按原压缩顺序提取后恢复阅读页序 | 文件 128 MiB，展开 256 MiB，单项 32 MiB、1500 页、10000 个目录项；不支持加密、分卷及超出 UnRAR 6.1.7 能力的新算法 |
| PDF | 按 PDF 页序逐页渲染 PNG，保留页旋转和完整页面 | 512 MiB、1500 页；144 dpi，按 1600 万像素及单边 8192 缩小；单页 PNG 32 MiB、整卷 1024 MiB；密码保护文件需先在本机解密 |

压缩包内支持 PNG、JPEG、WebP、GIF；GIF 转为 PNG 首帧。图片逐页解码、计算摘要并存入 IndexedDB，转换失败时撤销本次未完成导入的 Blob，不留下半本书。一次选择一本漫画文件，多张独立图片仍可一起导入。重新导入保持已有页 ID、用户排序、书名和阅读位置。

ZIP 按需读取 Blob 并限制实际解压输出；RAR 在独立 Worker 中运行，限制实际写出大小，每次只将一页交给主线程保存，结束或失败后终止 Worker。RAR 解码器需要整包及已展开资源驻留，因此限额低于 ZIP。PDF 按本地文件范围读取，顺序渲染并释放 canvas/page，不展示文档 HTML、执行 PDF 动作或上传 PDF 本身。RAR 操作和 PDF 页面渲染设 60 秒超时。

导入限额与后端翻译限额不同。后端仍按当前 capabilities 校验图片字节、像素和模型能力；可阅读不保证超大原图可直接翻译。EPUB、独立 KF8、长图切片仍属于后续范围。

## 实际命中规则

已有业务缓存键保持不变：

```text
SHA-256(canonical_json({
  owner: 当前账户 ID,
  hash: 后端对上传原图字节计算的 SHA-256,
  mode: classic 或 redraw,
  language: 目标语言,
  config_version: 有效配置快照摘要
}))
```

`config_version` 包含完整有效配置，不只模型名：重绘包括供应商配置、参数、提示词版本和点数；常规翻译包括 OCR/LaMa 引擎、文字模型/提示词、字体/渲染、重试预算和计价配置。当前实现中修改某些供应商超时、并发或显示配置也会改变快照。换模型、模式、目标语言或账户不会作为同一个成功结果缓存。

| 场景 | 行为 |
| --- | --- |
| 同用户、相同原图字节、模式/语言/配置相同 | 复用有效结果，文件名、来源 URL、包装格式不参与业务缓存键 |
| `queued` / `running` / `outcome_unknown` | 普通提交复用现有任务，不重复预占；图片重绘的未知结果还会跨配置阻止普通重新调用 |
| `succeeded` | 输入及输出仍可用时命中；直接创建接口返回 `cache_hit=true`、`cost=0`、`settlement=free` 的缓存任务 |
| `no_text` | 原图有效即可复用，无需再次 OCR |
| 失败、取消、要求丢弃结果 | 不作为可复用结果 |
| 图片到期、删除或存储文件缺失 | 不作为可用结果；默认保留期由后端配置决定，当前默认 7 天 |
| 主动生成新版本 | 走 rerun/force 和原有报价确认，跳过成功缓存 |

阅读器的**恢复展示**与新任务的**业务缓存命中**不同。`jobs` 按当前有效配置筛选；`display_jobs` 可返回同模式/语言的历史最新效果及失效标记。阅读器会继续展示已有有效效果，不因管理员换模型就自动重译；需要新效果时主动重新生成。恢复和查询本身不创建收费任务，因此看到已有译图，不一定意味着产生了一个 `cache_hit=true` 的新任务。

## 本次补齐：换压缩包也能免上传恢复

原来免上传查找先要求 `账户 + 整文件 SHA-256 + 原始页索引` 已建立映射。相同图片重新打包进另一个 ZIP/RAR 后，旧接口查找会未命中；上传后创建翻译仍能按原图内容缓存复用。

现在每个新导入页另存 `imageSha256`，摘要对应真正用于上传的图片字节（GIF 转 PNG 后、PDF 渲染后）。匹配请求支持可选 `image_sha256`：

```json
{
  "pages": [{"file_hash": "64位文件标识", "page_index": 0, "image_sha256": "64位原图摘要"}],
  "mode": "redraw",
  "target_language": "zh-Hans",
  "include_display": true
}
```

1. 优先检查已有文件页映射；提供图片摘要时也核对内容是否一致。
2. 没有文件页映射时，在**同账户的原图资产**中按 `image_sha256` 查找；输出资产不能冒充原图。
3. 有效原图匹配成功后，沿用同一业务缓存键和展示规则恢复任务、授权下载译图。命中时无需重新上传、报价或提交。
4. 匹配是只读操作，不根据客户端声明的摘要创建持久文件映射；上传时仍由后端计算摘要。已过期/删除的文件页映射不会通过其他副本自动复活。

MOBI、CBZ/ZIP、CBR/RAR 的 `file_hash` 是整个原文件 SHA-256。PDF 因为必须渲染，文件页标识从原文件摘要、PDF.js/渲染配置及该页最终 PNG 摘要派生；避免不同平台或渲染版本的字节差异造成旧映射冲突。所有页码均为 0 起始原始页索引，用户重排不重新编号。单图/网页图片仍用自身文件摘要及索引 0。

旧服务器图片即使没有 FilePage 映射，也可以被新客户端的页摘要找到。旧本地书架缺少页图片摘要时仍用已有文件匹配，重新导入会补齐；没有提供跨用户公共缓存。

## MD5 能否用于命中

按**原图内容摘要**命中的需求已支持，当前使用 SHA-256，不需要再增加 MD5 或迁移缓存。MD5 可以作为辅助索引，但不能只凭 MD5 决定授权或唯一内容；这里继续统一使用现有 SHA-256。

如果“翻译图片的 MD5”指**译后输出图**，在翻译前尚未拥有输出字节，无法拿它预查原图的翻译。重压缩、裁切、改分辨率、元数据变化或 PDF 重新渲染都可能改变字节摘要；本次不提供感知哈希/相似图片匹配。PDF 中看起来相同的图片也不保证与压缩包中直接提取的原始 PNG/JPEG 命中。

## 依赖与可重复验证

| 组件 | 锁定版本与来源 | 许可 |
| --- | --- | --- |
| [zip.js](https://github.com/gildas-lormeau/zip.js) | `@zip.js/zip.js 2.15.0`，使用本地 native streams 构建 | BSD-3-Clause |
| [node-unrar-js](https://github.com/YuJianrong/node-unrar.js) | `2.0.2`，内含 UnRAR `6.1.7` WASM | JS 包 MIT；UnRAR 使用其独立免费解压许可，包含禁止借此重建 RAR 压缩算法的条款 |
| [PDF.js](https://github.com/mozilla/pdf.js) | `pdfjs-dist 6.3.289`，legacy 主模块与同版本 Worker | Apache-2.0；内含 core-js `3.50.0`（MIT） |
| PDF 基础字体/字符映射/图像解码器 | 同一 PDF.js 包的 `standard_fonts`、`cmaps`、`wasm` | Foxit/PDFium BSD、Liberation SIL OFL 1.1、Adobe CMap BSD、QCMS MIT、OpenJPEG BSD 等；各自许可随构建打包 |

本次无模型权重。包下载地址与 SHA-512 integrity 在 [package-lock.json](../apps/extension/package-lock.json)；WASM、Worker、字体、CMap 的逐文件 SHA-256 在 [dependency-checksums.json](../apps/extension/public/import-assets/licenses/dependency-checksums.json)，其中还记录官方 UnRAR 6.1.7 源码包摘要。[UnRAR 许可](../apps/extension/public/import-assets/licenses/unrar.txt)与其他完整许可进入扩展和 Web 包。

RAR 的 Emscripten 动态命名和 Embind 参数转换函数由 [unrar-csp.ts](../apps/extension/unrar-csp.ts)替换为静态闭包，保留参数转换、析构顺序和原 WASM。升级时构建检查会要求重新审阅。MV3 只增加本地 WASM 所需的 `wasm-unsafe-eval`，未允许 JavaScript `unsafe-eval`。Worker、字体、WASM 均随扩展发布，无运行时 CDN 依赖。

验证命令与截图见[本次验收记录](evidence/import-cache-validation.md)。浏览器使用原创合成页，译图由隔离测试供应商产生，验证恢复及计费行为，不代表真实模型翻译效果。
