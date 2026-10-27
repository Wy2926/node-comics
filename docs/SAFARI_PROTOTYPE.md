# Safari 技术验证

范围是 iOS Safari Web Extension 的登录、网站取图和翻译链路。复用现有阅读器、站点适配器和翻译契约，容器由 Apple 的打包工具生成；没有上架、签名发布或后端部署步骤。其余功能保留在构建中，但不据此宣称已经通过 Safari 验收。

## 环境与构建

需要 macOS、完整 Xcode、iOS 26 或更新的模拟器运行时，以及[插件开发环境](../apps/extension/README.md#运行与构建)。模拟器构建关闭代码签名，不需要付费 Apple Developer Program 会员。真机测试与分发的签名方式另行配置。

在 Xcode 中完成首次初始化，在 Settings → Components 下载 iOS 运行时；也可使用 `xcodebuild -downloadPlatform iOS -architectureVariant arm64`（Apple Silicon）。脚本默认查找 `/Applications/Xcode.app`，其他位置通过 `DEVELOPER_DIR` 指定，不修改系统的默认开发工具目录。

在 `apps/extension` 执行：

```sh
npm ci
npm run safari:simulator -- prepare
npm run safari:simulator -- doctor
npm run safari:simulator -- install <doctor列出的UDID>
```

`prepare` 构建 `.output/safari-mv3`，调用 `safari-web-extension-packager`（旧版 Xcode 为 `safari-web-extension-converter`）生成 `.output/safari-project`，并复制仓库维护的 `safari/SafariWebExtensionHandler.swift`，替换会记录消息内容的模板处理器。`install` 同步此原生源码、编译到 `.output/safari-derived-data`，启动并安装到指定模拟器。三处目录均为可重建、忽略的本机产物；不要在生成目录中保存签名配置或手工维护源码。

Xcode 27 的模拟器界面为 Device Hub；脚本自动识别它和旧版 Simulator，不依赖旧应用路径。

重新安装构建后，关闭旧阅读器标签页，再从扩展弹窗重新打开；已打开页面可能仍引用旧构建的分块资源，不能用它判断新构建是否正常。

首次安装后，在模拟器的 Safari 页面菜单 → 管理扩展中启用 NodeLane，再在设置中允许该扩展访问所有网站。安装成功不代表扩展已经启用。Safari 的权限帮助入口为扩展自带的 `safari.html`。若阅读器在授权前已尝试加载登录配置，授权后点击“重新连接登录服务”即可重试。

## 隔离验证

仓库根目录先生成原创样本并启动回环服务，Python 需要 Pillow、ReportLab：

```sh
python3 scripts/generate_import_fixtures.py
node scripts/safari_fixture_server.mjs
```

另一个终端执行：

```sh
cd apps/extension
VITE_API_BASE=http://127.0.0.1:4737 npm run safari:simulator -- prepare
cd ../..
node scripts/prepare_safari_fixture.mjs
cd apps/extension
npm run safari:simulator -- install <UDID>
```

模拟器共享 Mac 的回环网络。打开 `http://localhost:4737/`，扩展弹窗的临时 **Safari API probe** 链接检查运行时 API、网站权限、令牌请求 Origin、取图 Referer 和重定向可见性。该链接与探针仅加入已指向回环服务的构建；重新运行正常 `prepare` 会清除它们。探针结果及服务计数在 `http://127.0.0.1:4737/__state`，不记录令牌、Cookie、授权码或私有图片。

完整交互仍需通过阅读器和网页入口操作：

- 登录测试账户，检查拒绝、取消后重试、成功回到原标签页；回调页立即清除查询参数，以覆盖与官网相同的时序。
- 打开公开图片和重定向图片页面，通过“翻译当前标签页”读取原创图片；探针另测严格 Referer 的原生分支、Cookie 隔离、超限、challenge 与取消。通用网页入口未选择原生通道时仍作为防盗链反例，不能混算通过。
- 确认任务创建、上传、事件同步、结果下载和显示，以及切回原图的位置。合成返回图片把 PAGE 1 改为 PAGE 2，不能用来评价 OCR 或模型效果。
- 使用源码中的桌面回归脚本检查 Chrome 登录与原阅读位置；单元测试不能替代 Safari 扩展 API 实测。

服务仅绑定 `127.0.0.1:4737`，模拟 PKCE、账户与翻译协议，不连接数据库或真实供应商。测试结束后停止服务；恢复正式 API 需不带 `VITE_API_BASE` 重新 `prepare` 并安装，避免把夹具构建用于真实账户。

## 兼容边界

Safari 构建移除 iOS 不支持的 `identity`、`webRequest` 和 `contextMenus` 权限，增加 `webNavigation` 与 `nativeMessaging`。登录使用受绑定的独立标签页，复用官网回调；令牌交换由小型 Swift 处理器完成，具体安全规则归属[身份配置](PRODUCTION_IDENTITY.md)。iOS 26 下限来自现有 DNR 规则的 `initiatorDomains` 条件，不代表每个 26+ 版本都已实测。

Safari 网站权限模式不接受端口号；权限模式按协议与主机生成，实际网络 URL 保留原端口。消息目标使用 `documentId`（可用时）或主框架 `frameId: 0`，不同时传两者；接收端仍核对文档和导航身份。

取图沿用[公共读取规则](IMAGE_ACCESS.md)。Safari 扩展自身的 DNR Referer 修改及直接设置请求头不生效，XHR 和源站页面跨域 fetch 也未解决实测站点。已确认公开访问的站点显式选择原生 GET，分块传回字节；图片重定向返回扩展逐跳检查权限，源站 Cookie 不转移。未声明原生通道的站点继续使用浏览器取图，其严格防盗链或无法读取 Location 的情况仍可能失败。

DM5 与 NAVER 的桌面解析请求显式使用桌面 User-Agent，避免 iPhone 被重定向到移动版结构。长请求地址对应的 Web Lock 名称改为摘要，修复 Pixiv 目录请求超过 Safari 1024 字符限制的问题。具体适配声明见[网站适配规范](SITE_ADAPTERS.md)，原生预算与清理规则见[公共图片读取](IMAGE_ACCESS.md#safari-公开来源通道)。

## 当前验收范围

Xcode 27.1、iOS 27.1 的 iPhone Duo 模拟器，配合上述本机合成服务：

| 路径 | 结果 |
| --- | --- |
| 登录成功、拒绝授权、关闭授权页后重试、返回原标签页 | 通过；官网式回调清参时序已覆盖 |
| 原生令牌 POST | 无 Origin／Cookie；拒绝非回环 HTTP、重定向和超限响应 |
| 公开图片与 HTTP 重定向图片 | 通过；手动重定向的 Location 可读 |
| 创建任务、上传、事件同步、结果下载与显示 | 通过；使用合成结果，不调用模型 |
| 原图／结果切换 | 通过；保持页面位置，复用已有结果 |
| 通用网页严格 Referer（浏览器通道） | 仍返回 403；原生分支验收见下表 |
| Chrome 登录与通用网页翻译回归 | 通过；使用模拟服务 |

另在 iOS 27.0 的 iPhone 16 模拟器中，使用正常生产构建和用户提供的测试账户验证了正式服务：

| 路径 | 结果 |
| --- | --- |
| 正式身份服务登录、原生换码、返回阅读器、读取账户额度 | 通过 |
| 本机原创网页的跨主机图片读取 → 正式翻译服务 → 页面显示 | 通过；一张 800 × 1100 图片的英文对白已替换为中文 |
| 原图／译图往返切换 | 通过；四个状态的图片边界和滚动位置完全一致，显示宽高为 393 × 540.375 CSS 像素 |
| [DM5 真实短篇](https://www.dm5.com/manhua-zuixihuanxuejiedetudingmen/) → 正式翻译 → 阅读器 | 第 27–30 页四页通过；中译英，原图／译图往返、27→28→29→30→29 翻页、退出重开及刷新后重开通过；第 29 页内偏移恢复一致 |
| [Pixiv 三页漫画](https://www.pixiv.net/artworks/135708866) → 正式翻译 → 阅读器 | 三页及随读预取的下一作品一页通过；中译英，2181 × 3163 原图的三页译图为 1800 × 2610；显示边界保持 393 × 569.9375 CSS 像素，原图切换、1→2→3→2、触摸连续滚动、退出重开及刷新后重开通过 |
| 任务复用与额度 | 两站共八个新请求、八次上传、八个成功结果；切换与重开没有创建新请求或重复上传，测试额度仅消耗八页 |

同一 iOS 27.0 模拟器的来源读取覆盖如下；本表只统计解析与取图：

| 样本 | 结果 |
| --- | --- |
| [Pixiv 公开漫画目录](https://www.pixiv.net/users/25786514/manga) | 51 个条目；首作品原图从 403 修复为可读，6,543,216 字节、4299 × 6071 |
| [DM5 公开短篇](https://www.dm5.com/manhua-zuixihuanxuejiedetudingmen/) | 桌面目录及图片地址接口均通过，完整解析 30 页；阅读器滚动至第 3 页及返回无取图错误 |
| [NAVER 公开作品](https://comic.naver.com/webtoon/list?titleId=758037) | 270 个目录条目，首话解析 137 页；浏览器通道读取首图 690 × 1600，无需启用原生图片读取 |
| [Comic PASH 公开章节入口](https://comicpash.jp/episodes/60cfe4785e2af) | 解析所属作品的 44 个条目、首可读章节的 50 页；首图从 403 修复为可读并完成拼图解码，720 × 1024 |
| 原生回环边界 | 严格 Referer、手动重定向、Cookie 不保存／不回传、challenge 拦截、已声明及无 Content-Length 的超限拒绝、取消中止与临时文件清理通过；三个请求实测最多两个同时传输 |

Safari 画布请求 WebP 编码时实测返回 PNG。送译副本已按[翻译契约](READING_TRANSLATION_CONTRACT.md#3-创建与上传)接受有界头校验后的 PNG，并冻结独立编码策略；原图保留，恢复不切换既有策略。Pixiv 四张送译 PNG 为 2.46–2.77 MB，单次上传实测 2.7–4.1 秒；这是当前网络的单次样本，不是吞吐基准。PNG 保留透明度并复用一次编码，但相对 WebP 可能增加网络与缓存开销；同像素跨浏览器压缩率、峰值内存和真机耗电尚未测量。输入与恢复相关 106 项测试、Chrome 69 项实际像素／缓存检查及插件静态检查通过。

已知稳定性限制：开发安装环境中，测试脚本通过整页地址跳转进入阅读器曾出现 IndexedDB 操作停滞并占用导入锁，重启 Safari 可恢复；根因尚未完全定位。产品内作者目录导入、退出阅读、刷新及重开复测通过，这不替代多标签和长时间后台恢复验证。

上述是代表性样本，不代表各站所有章节或全部适配器验收；目录页数不等于整章全部图片已经下载。真实漫画已抽查英文译图与原图，部分窄竖排气泡的英文换行较碎，模型和排版质量仍须独立评价。依赖登录 Cookie 的图片、通用网页严格防盗链、真机内存与耗电，以及 App Store 审核仍须分别验证。没有修改正式服务配置、部署后端或开通 Apple 开发者会员。

Apple 参考：[扩展打包](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)、[运行扩展](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)、[原生消息](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)、[排查扩展](https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension)。请求头限制的跟踪见 [WebKit 253696](https://bugs.webkit.org/show_bug.cgi?id=253696)。
