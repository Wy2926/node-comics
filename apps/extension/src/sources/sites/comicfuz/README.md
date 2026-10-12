# COMIC FUZ

支持 `https://comic-fuz.com/manga/<mangaId>` 连载作品，以及 `?chapterId=<chapterId>` 章节。提供名称搜索、完整公开目录、分卷、封面、原图读取／还原、浮动导入入口和 12 小时目录同步。单行本商店 `/book/`、杂志 `/magazine/` 不作为连载目录导入。

标签页翻译仅声明 `inlineRecognition: 'generic'`，没有站点 `page.ts` 或 `decodeInline`。通用识图独立于用于导入的目录／章节分类，详情页内嵌阅读器同样使用既有大图／Blob 识别，仍受通用尺寸、可见性与导航失效规则约束。

## 协议与边界

- 目录读取作品页 `__NEXT_DATA__.props.pageProps` 的完整 `chapters`，核对路由、作品 ID 和初始阅读按钮的章节归属。保留源站分卷、标题及不可读条目，按照源站“1話から”顺序排列；不同卷不建立跨组连读。目录更新不另外保存状态。
- 搜索使用 `POST https://api.comic-fuz.com/v1/search`；正文使用 `web_manga_viewer_2`。请求及响应为 Protobuf，本站仅实现必需 wire 类型和字段，不引入运行时依赖，不执行下载的脚本。公共 `requestBytes` 保持权限、取消、30 秒、1 MiB 请求及 8 MiB 响应限制，不进入 GET 交接缓存，不用于网页上下文通道。
- 正文核对响应作品、章节和目录归属，只返回完整 `viewerData.pages` 内的正文图片，排除明确的 `isExtraPage`、广告、webview 和结束面板；保留页槽及原始顺序。校验图片主机、章节编码与路径，版本化路径作为内容标识，签名更新不改变页身份。
- `.enc` 图片按响应提供的 AES-256-CBC 参数在公共取图后还原，校验图片格式；不获取或推断未返回的内容。封面只取已验证作品记录中的 `mainThumbnailUrl`。
- 请求固定 `useTicket=false`、`consumePoint.event=0`、`consumePoint.paid=0`。公开目录需点数的章节保留为不可读，不自动解锁、扣点或购买；接口未授予正文时明确失败。此适配不承诺已购内容的自动导入。
- 图片服务需要源站自行设置的匿名会话，公共网络和取图管线均使用既有 `credentials: include`。不提取或上传源站 Cookie；浏览器禁用 Cookie 或来源访问权限时需用户在源站恢复。HTTP 验证自行建立匿名会话，不使用用户登录凭据，退出即删除临时 Cookie 文件。
- 每次目录更新一次 HTML 请求；每章一次二进制请求；搜索每页一次请求。目录读取不下载正文图片，图片沿用阅读器有限窗口。签名、还原参数及漫画字节不写入日志或夹具。

协议依据为源站公开 [作品页](https://comic-fuz.com/manga/2062)、[免费章节](https://comic-fuz.com/manga/2062?chapterId=47170) 与其公开 Web 客户端消息结构；解析器和 wire 编解码器为本项目独立实现，不复制第三方客户端代码。消息字段留在本站，wire 基础复用 `shared/protobuf.ts`。图标为本地文字标识，不是官方 Logo。

## 验证

```powershell
# apps/extension
npx vitest run src/sources/sites/comicfuz/tests/network.test.ts tests/source-http-form.test.ts
npm run check
npm run build

# 仓库根目录；不使用账号、不调用翻译模型
node apps/extension/src/sources/sites/comicfuz/tests/verify-http.mjs
```

HTTP 验证覆盖多作品目录、免费章节首尾页解码、搜索和空结果；可用 `SOURCE_TEST_PROXY` 指定本机已有代理。`--build-only` 仅构建浏览器诊断包到忽略的 `artifacts/comicfuz/`，不代表 HTTP 或扩展验收通过。真实扩展导入、重开位置恢复及通用标签页翻译需另在桌面浏览器验证。
