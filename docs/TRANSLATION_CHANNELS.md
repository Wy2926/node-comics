# 客户端翻译渠道

插件提供内置 NodeLane 渠道与可配置的 manga-translator-ui（MTU）渠道。阅读器和网页原位翻译共用当前渠道；支持添加多个 MTU 服务配置，每次只选择一个。MTU 使用用户自己的服务与算力，无需 NodeLane 账号，不使用官方额度。

## 代码职责

入口为 [`translation/channels/index.ts`](../apps/extension/src/translation/channels/index.ts)，类型契约为 [`contracts.ts`](../apps/extension/src/translation/channels/contracts.ts)。

| 模块 | 职责 |
| --- | --- |
| `channels/registry.ts` | 唯一具体适配器装配入口，只导入各适配器的 `definition.ts` |
| `channels/adapters/nodelane/` | 官方登录、能力与权益、UUID 请求、补传、状态查询、恢复和结果下载 |
| `channels/adapters/manga-translator-ui/` | MTU 登录、语言映射、表单与错误映射 |
| `channels/transport/` | 与协议无关的直传执行、本地排程、执行回执和长请求宿主 |
| `translation/automatic.ts`、`useAutomaticTranslation.ts` | 当前页与后三页窗口、渠道运行器调用及显示更新 |
| `storage/translations/` | 按渠道作用域保存、校验和读取译图 |

`ChannelDefinition` 声明配置字段并建立连接；`ChannelConnection` 提供能力、作用域、结果读取和运行器工厂；`ChannelRuntime` 提供 `init/submit/manual/wait/stateFor/refresh/dispose`。`submit` 更新阅读窗口并启动工作，不等待整张译图。官方查询与恢复留在官方运行器内，MTU 运行器只等待一次图片 HTTP 调用的结果。

公共层不按协议 ID 分支执行。界面按适配器字段描述渲染配置；适配器不得互相依赖或引用界面实现；契约不得依赖装配/执行层；直传层不得依赖具体适配器或官方账号/API。旧的公共 `translation/coordinator.ts`、`store.ts`、`state.ts` 已移入官方目录，不保留转发文件。`check:modules` 检查这些边界、传递依赖、运行时循环及未被使用的模块。

## 两个渠道的执行约定

**NodeLane** 保留[官方翻译接口与恢复契约](READING_TRANSLATION_CONTRACT.md)：登录后受理请求、必要时补传原图、按 UUID 查询、下载完成结果。网络未知结果不能自动生成新 UUID；查询或下载失败不能触发重译。退出账号仍隔离该账号的结果。未登录时展示模式与登录入口，不发送翻译请求。

**MTU** 仅实现以下接口，对照版本为 [`hgmzhn/manga-translator-ui@2130ccb`](https://github.com/hgmzhn/manga-translator-ui/tree/2130ccb108dea055e6e105e9aa7d3cfb52f4150d)：

1. `POST /auth/login`：提交用户名、密码，取得渠道 Token；密码不保存。
2. `POST /translate/with-form/image`：`X-Session-Token` 鉴权，multipart 提交 `image` 与 JSON 字符串 `config`；`config.translator.target_lang` 使用 MTU 语言代码。完成后读取并解码验证图片。

MTU 首期仅提供常规翻译，使用服务端其余默认配置；不接流式接口、历史任务、远端取消、远端恢复或自动故障切换。Token 失效后在渠道设置重新连接；不会隐式重发翻译。

## 执行寿命与缓存

- 同一 MTU 渠道串行执行图片，当前页优先，随后处理阅读窗口的后三页。阅读器扩展页面直接承载 HTTP 请求；网页原位翻译由非激活的扩展执行标签页承载，请求结束后自动关闭空闲宿主。无需让 service worker 持有整段长连接。
- 发送前写入本地执行回执；恢复时仅读取回执，不重放 HTTP。宿主关闭、超时或连接中断后提示手动重试，不能据此断言远端计算已停止。
- 请求从后台交给宿主、或阅读器交给直传执行器时，必须等执行器实际持有请求锁后才确认接收并释放启动锁；中断判定按启动锁、请求锁的顺序原子检查，避免跨进程锁登记延迟造成误判。确认接收不等待整张图片完成。
- 渠道切换使原上下文失效；晚到结果归属原作用域，不覆盖新渠道。MTU 是否可调用由实际连接决定，不以互联网离线状态阻止本机服务。
- 本地作用域为配置 ID 与配置修订；官方作用域为服务与账号身份。修改服务配置改变修订；重命名、刷新 Token 不让已有译图失效。凭据不进入作用域、日志或图片回执。
- 结果记录声明是否可从渠道重新读取。官方缓存缺失可以重新下载；MTU 缓存缺失只提示手动重译。已有译图导出只读取现有结果，不创建翻译请求。
- 译图预算为 0 时不持久保存译图，但允许活跃扩展上下文保留少量内存图片并相互读取；最后持有图片的上下文关闭后，本地结果需要重译。后台从共享偏好读取预算并跟随修改；清理操作同时使在途旧结果和其他上下文中的缓存失效。

## 验证

在 `apps/extension`，安装项目依赖后执行：

```sh
npm run check
npm test
npm run build
```

针对性检查可使用 `npm test -- tests/module-boundaries.test.ts tests/translation-resources.test.ts tests/translation-content-recovery.test.ts src/translation/channels/adapters/nodelane/definition.test.ts`；MTU 协议、直传与缓存测试位于对应模块及 `tests/result-cache.test.ts`。

渠道设置与阅读器交互检查：先在 `apps/extension` 执行 `npm run dev -- --port 5176`，再在仓库根运行 `node scripts/verify_translation_channels.mjs`。它在新浏览器上下文验证失败登录、未登录使用 MTU、渠道与模式切换、阅读位置、缓存清理后的显式重译及本机服务在互联网离线标记下的调用。官方阅读窗口和原位翻译分别运行 `scripts/verify_reading_translations.mjs` 与 `scripts/verify_inline_translation.mjs`。

MTU 宿主的浏览器检查从仓库根目录执行 `node scripts/verify_translation_channel_host.mjs`，先完成上面的 Chrome 扩展构建。需要可用的 Playwright 与支持扩展的 Chromium；非本地依赖可通过 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，`CHROMIUM_PATH` 或 `TEST_CHROMIUM` 指定浏览器可执行文件。脚本复制构建产物到独立目录、使用新浏览器资料与合成图片，并仅在副本授予本机测试源权限；不会连接用户的 MTU 服务或使用用户资料。

单测验证接口行为、渠道隔离、幂等恢复和中断策略；模拟浏览器验收覆盖未登录使用 MTU、切换渠道、原位翻译长请求、宿主关闭及缓存清理。渠道设置夹具使用模拟登录；宿主重启夹具直接写入合成令牌，因此这两组检查不能代替真实登录验收。

### 真实本机服务验收

先构建 Chrome 扩展，再设置 `MTU_USERNAME`、`MTU_PASSWORD` 环境变量，从仓库根运行 `node scripts/verify_translation_channel_live.mjs`。默认服务为 `http://127.0.0.1:8000/`，可用 `MTU_BASE_URL` 指定其他回环地址；浏览器变量与宿主脚本相同。脚本会实际调用服务端配置的翻译引擎，使用合成英文图片、目标语言 `CHS`，其余参数采用服务端默认值。它通过真实设置页登录，不替换 MTU 响应或预置令牌；校验原位显示和刷新复用。权限仅在隔离扩展副本预授予，未覆盖原生权限弹窗。

结果、原图、译图及截图保存在被忽略的 `artifacts/translation-channel-live/<run-id>/`。凭据只从进程环境传入，报告不含密码或令牌；结束后注销该测试会话并删除浏览器 profile。默认最多等待 5 分钟（`MTU_TIMEOUT_MS` 可调整），失败不自动重发。
