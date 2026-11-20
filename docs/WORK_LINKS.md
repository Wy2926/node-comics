# 网站漫画关联与作品评论

每个书架条目在本机按资料站保存作品 ID。关联只用于查资料和评论，不合并同名漫画、阅读来源或进度。

- **发现导入**：选择阅读来源时沿用当前作品的 `(providerId, workId)`；修改搜索词不会改变它。导入和目录刷新都不会覆盖用户的选择或明确解除的关联。
- **手动关联**：在书架或阅读器的「评论 → 作品关联」按名称、别名、AniList 漫画链接或 `id:编号` 搜索。即使只有一个候选，也要点「关联此作品」才保存。
- **阅读评论**：「发现」在作品详情窗口显示书评；书架和阅读器使用独立浮层。只有当前阅读来源能验证具体发布条目时，才显示「本章评论」。

## 适配器入口

- 阅读站通过 [`externalWorkIds`](../apps/extension/src/sources/contracts/source.ts) 提供源站明确发布的稳定 ID，例如 MangaDex 的 `attributes.links.al`。匹配方式参考 [MAL-Sync](https://github.com/MALSync/MALSync/blob/master/src/pages/Mangadex/main.ts) 和 [Mihon](https://github.com/mihonapp/mihon/blob/main/app/src/main/java/eu/kanade/tachiyomi/data/track/anilist/Anilist.kt)。
- 资料站在 [`discovery/providers/`](../apps/extension/src/discovery/providers/) 导出 [`WorkProvider`](../apps/extension/src/discovery/types.ts)：`search` 提供候选，`catalog` 和 `reviews` 为可选能力。[AniList 书评](https://docs.anilist.co/reference/object/review)区分作者评分与读者投票，和榜单共享[限流冷却](https://docs.anilist.co/guide/rate-limiting)。正文仅重建允许的排版、链接和 HTTPS 图片，剧透默认折叠。
- 章节讨论实现 [`SourceNetwork.chapterComments`](../apps/extension/src/sources/contracts/network.ts)。运行时核对来源目录和章节标识，以可取消的匿名 GET 分页读取；[WEBTOON](https://github.com/Webtoon-Studio/webtoon/blob/main/src/platform/webtoons/client.rs) 按 Originals / Canvas、作品号和期号区分讨论。
