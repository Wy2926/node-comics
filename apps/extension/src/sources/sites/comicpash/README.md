# Comic PASH!

仅认领 `comicpash.jp`／`www.comicpash.jp` 的 `/episodes/<id>`。`page.ts` 读取 Comici 漫画容器中已渲染的 canvas，排除广告、点赞和结束页；站点专属属性观察也在此处。画布对象、渲染状态、尺寸和 episode 改变后旧版本不可再读取。

没有目录、自动翻页或整章补全能力。当前画布窗口始终为部分清单，页槽数不作为整章完整的证据；分辨率以网页渲染结果为准。临时资源由公共运行时签发句柄，站点不决定读取授权。`tests/page.test.ts` 与 `scripts/verify_comicpash.mjs`、`scripts/verify_inline_translation.mjs` 分别覆盖契约和隔离浏览器行为；真实网页可用 `RUN_LIVE_COMICPASH=1` 单独验证。
