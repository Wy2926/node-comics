# ゼブラック · Zebrack

支持集英社 [Zebrack](https://zebrack-comic.shueisha.co.jp/) 的「話読み」漫画：名称搜索、完整分话目录及源站分卷、作品封面、公开免费正文、网页浮动导入入口和 12 小时目录同步。

- 作品：`/title/<titleId>`；完整分话列表：`/title/<titleId>/chapter/list`。
- 章节：`/title/<titleId>/chapter/<chapterId>/viewer`，URL 同时绑定作品和章节。
- 单行本 `/volume/`、小说 `/novel/`、杂志商店不作为「話読み」目录导入；搜索可能返回没有分话目录的作品，导入时明确提示，不把试阅当成完整单行本。
- 目录保留收费、租借及阅读券条目，只有源站明确标为 `FREE` 且价格为零的章节可读取。不传登录 secret，不自动购买、租借、扣点或消耗阅读券，也不承诺导入已购内容。
- 标签页翻译显式复用 `inlineRecognition: 'generic'`。源站阅读器将已解码图片挂载为同源 Blob，通用逻辑处理懒加载、已撤销 Blob、有限窗口和导航失效；本站没有重复的 `page.ts` 或原位解码钩子。通用识别不宣称整章完整性。

## 协议与性能

接口为 `https://api2.zebrack-comic.com/api/`：`GET browser/title_detail?tab=chapter` 提供作品身份和专门封面，`GET v3/title_chapter_list` 提供完整升序目录，不能用详情页五条预览代替；分组名称由 `indexGroups` 中的源站目录标签关联，组内连读，不推断跨组关系。`GET v3/title_search` 返回轻量漫画候选，小说结果不纳入。搜索完整结果按每页 50 条切片，下一页重新读取接口，不保留全局缓存，也不逐作品抓目录。

每章先重新检查目录中的公开免费状态及作品归属，再表单 `POST v3/chapter_viewer`，固定 `type=normal`、`event_point=0`、`paid_point=0`。只接受响应中明确的正文 `image`，排除广告、跳转宣传图和结束面板；保留原始槽位和重复图片，不为缺口重编号。图片路径必须绑定同一作品及章节。源站不返回尺寸时登记零尺寸，实际取图后由公共层核验。

正文按接口附带的 64 字节循环 XOR 参数还原，校验 JPEG／PNG／WebP 格式；只处理源站正常返回的免费正文，不猜测未授权资源。页槽及稳定图片路径作为内容标识，临时签名更新不改变阅读进度。签名、图片正文和还原参数不进入夹具或日志。

目录读取固定两次并发 API 请求；每章两次顺序 API 请求，免费状态预检增加一次目录读取，以避免隐式消耗阅读权益。搜索每次一条请求，无逐作品请求扩散。图片沿用阅读器有限窗口，不预下载整章。公共二进制传输复用 GET／表单 POST 的权限、30 秒、1 MiB 请求体及 8 MiB 响应限制。

协议来自官方公开 [作品](https://zebrack-comic.shueisha.co.jp/title/9)、[免费第一话](https://zebrack-comic.shueisha.co.jp/title/9/chapter/2231/viewer) 与 Web 客户端消息结构。参考脚本版本：`index-BjJ1t2rx.js`（SHA-256 `1bed73b7644f79eb0aa88f9f393a09086806ab3c4675623ee4b8dd9f53d2d67d`）、`LtrIcon-Do11C8i0.js`（SHA-256 `ddff61dc733f8ab3d880d18cc9359ed09e7d2c98f3f12546cbef3a9465b5acc3`）。解析和解码为本项目独立实现，不执行或分发下载的第三方脚本；无新增依赖。Protobuf wire 基础复用 `shared/protobuf.ts`，消息字段留在本站。图标为本地文字标识，非官方 Logo。

## 验证

```powershell
# apps/extension
npx vitest run src/sources/sites/zebrack/tests/network.test.ts tests/source-http-form.test.ts
npm run check
npm test
npm run build

# 仓库根目录；只调用公开接口，不使用用户账号或翻译模型
node apps/extension/src/sources/sites/zebrack/tests/verify-http.mjs
```

HTTP 验证覆盖三部漫画、六个免费章节、目录／分卷／封面、首尾图解码、搜索及空结果，输出请求数、传输量与耗时，不保存签名或漫画字节。`--build-only` 生成浏览器诊断包 `artifacts/zebrack/live.js`，可在公开阅读页检查 `pageFactories.zebrack` 的 Blob 读取、取消和像素一致性；生成诊断包不代表浏览器或扩展验收通过。

真实扩展安装、导入到阅读器、重开位置恢复、访问权限撤回与原位译图恢复须另在桌面浏览器验证。HTTP／页面诊断和模拟测试不代表真实翻译模型效果。
