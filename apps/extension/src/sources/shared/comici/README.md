# Comici 共享协议

由 [Comic PASH](../../sites/comicpash/README.md) 与 [HERO'S Web](../../sites/heros/README.md) 显式调用，共用编号目录、搜索响应、viewer 元数据、正文接口与 canvas 容器协议；域名、URL 身份、图片归属、搜索页大小及安装入口由各站声明，不自动认领未知网站。

- `network.ts`：读取编号目录页并核对连续范围、数量、唯一性与 canonical，多页目录重读首页检查变化。作品首页可能折叠，不能把其首尾条目当完整目录。裸章节从 viewer 元数据绑定作品；正文通过 `contentsInfo` 的两次有界 GET 核对总数、页序、尺寸及图块配方。站点校验 `/book/<viewer-id>/` 图片归属。
- `search.ts`：只返回名称匹配的 `searchResult.series`，不抓候选目录，排除作者匹配和章节结果。每页数量取自站点配置；跨页排序可能变化，由现有搜索会话按来源与作品 ID 去重，不创建额外搜索缓存。
- `page.ts`：只读取 `#comici-viewer #xCVPages` 中带正文 canvas 的已渲染页槽；不把广告、空页、结束页当正文，不用窗口快照宣称整章完整。延续画布重绘、尺寸、导航、取消与销毁失效检查，不在扫描阶段编码像素。
- `images.ts`：独立实现 4×4 按列排列的图块置换；保持持久化 `comici-v1` 标记及源站透明余边行为。按需解码，不预取全章图片。

协议依据为两站公开页面和各自 `/js/viewer/viewer.js`。HEROS 与 Comic PASH 验证样本的脚本 SHA-256 相同：`ba9199d3996e4e8feca4d36bfd82e9d185aa7b2310f7b4f3273290bda68fc06a`。不执行、复制或随包分发源站脚本，无新增第三方组件。单测及真实 HTTP 验证入口保留在两站 `tests/`，站点 README 说明验证边界。
