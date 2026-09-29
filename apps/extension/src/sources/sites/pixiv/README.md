# Pixiv

- `https://www.pixiv.net/users/<作者 ID>` 与 `/users/<作者 ID>/artworks` 导入插画＋漫画全集；`/users/<作者 ID>/illustrations` 只导入插画，`/users/<作者 ID>/manga` 只导入漫画。在后三种路径末尾添加 `/<标签>`，只导入相应分类下的该标签作品。
- `https://www.pixiv.net/user/<作者 ID>/series/<系列 ID>` 将一个系列导入为独立一本漫画，使用系列名称与明确的作品序号，排除接口附带的其他系列和推荐作品。
- 支持 `/en/` 前缀，分页参数不改变漫画身份。主页与 `/artworks` 共用原有全集身份；分类、标签和系列分别独立。重复导入同一范围复用已有漫画和进度，更新始终保留原导入范围。
- 作者主页、插画、漫画、标签与系列页左下角显示“导入/管理漫画”按钮，随站内导航更新；Pixiv 的网页入口、插件弹窗、阅读器及书架菜单不显示“寻找其他语言”。
- 每个作品是一话，多图作品按源站页序读取全部原图；作者目录按作品 ID 从旧到新排列，系列按源站序号排列。全部目录接入公共 12 小时同步、更新徽章与阅读位置恢复，不另建轮询任务。
- 原生 `/artworks/<作品 ID>` 网页沿用通用已加载大图识别与翻译；不提供单作品链接建库。目录内部的作品地址携带作者、分类、标签或系列绑定；这些地址也显式使用通用原位识别，不用网页可见图片补全阅读器清单。
- 仅包含当前浏览器会话可访问的作品。登录或权限受限、接口失败、分页不完整时明确失败；不会用缩略图冒充原图。动画保留目录条目但不可阅读，小说不属于 `artworks` 范围。作者头像与作品缩略图不作为整本封面。

协议来自 Pixiv 自身公开网页所用的 AJAX 响应：作者 `/ajax/user/<id>`、`/profile/all` 与 `/profile/illusts`；分类标签 `/illustmanga/tag`、`/illusts/tag`、`/manga/tag`；系列 `/ajax/series/<id>?p=<页码>`；正文 `/ajax/illust/<id>[/pages]`。系列直接信任接口的作品列表及顺序，不重复校验摘要或详情中的系列归属，也不要求作品序号连续或元数据版本一致；仅在缺少作品摘要时读取详情补齐标题与页数。保留目录总数、分页完整性与重复作品检查，防止更新时漏掉章节。无标签作者目录按首次取得的作品 ID 分批读取，不重复请求列表；分类和标签导入保留对应筛选范围。只解析 JSON，不执行源站脚本。原图来自 `i.pximg.net/img-original/`，通过公共取图管线生成来源 Referer；会话 Cookie 只由浏览器发送给源站。图标为本地绘制的字母标识。

## 验证

在插件目录执行 `npm run check`、`npm test`、`npm run build`。从仓库根目录执行：

```powershell
node apps/extension/src/sources/sites/pixiv/tests/verify-http.mjs
node apps/extension/src/sources/sites/pixiv/tests/verify-browser.mjs
$env:INLINE_SITE_ONLY = 'pixiv'
node scripts/verify_inline_translation.mjs
Remove-Item Env:INLINE_SITE_ONLY
```

HTTP 脚本读取公开作者主页、插画、漫画及各自的标签目录，并检查作品页序与真实原图；默认作者 `25786514`、标签 `二創`，可通过 `PIXIV_USER_ID`、`PIXIV_TAG` 调整，`PIXIV_SERIES_ID` 可追加该作者的系列。浏览器脚本默认使用隔离 MV3 profile 和原创图片夹具，检查分类／标签／系列导入隔离、系列摘要缺项补齐后入库、重开恢复、失败保留与幂等更新；`RUN_LIVE_PIXIV=1` 改用上述真实公开来源。使用已有 `PLAYWRIGHT_MODULE`、`TEST_CHROMIUM` 环境变量指定运行时。

原位脚本使用模拟翻译服务验证通用识别、懒加载、译图／原图切换与导航清理，浏览器路径用 `CHROMIUM_PATH`；不验证真实模型效果或需要登录的受限作品。产物写入忽略的 `artifacts/pixiv/` 与公共原位脚本产物目录。
