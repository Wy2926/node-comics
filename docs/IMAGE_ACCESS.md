# 公共图片读取

阅读器和原位翻译共用 [image-fetch.ts](../apps/extension/src/sources/runtime/image-fetch.ts)。图片发现只产生资源引用，完成权限检查、读取和解码后才可用于翻译。

## 读取规则

| 资源 | 读取方式 |
| --- | --- |
| HTTP(S) 图片 | 受信扩展上下文请求原始字节，检查实际图片域名权限 |
| Blob / Data | 在拥有该资源的页面上下文读取 |
| 已还原 Canvas | 经站点声明读取页面像素；绑定文档、元素和导航版本 |

- 由已校验的来源页与引用策略生成 Referer；站点通过 `image.headers` / `coverHeaders` 声明必要差异。原位入口读取图片属性和 meta，缺省采用 `strict-origin-when-cross-origin`，不回溯页面响应头。
- DNR 规则只匹配当前精确图片 URL，同 URL 请求由 Web Lock 串行隔离；完成、失败和取消均清理。
- `webRequest` 仅在请求期间观察扩展自身的重定向响应头。最多跟随 5 次跳转，每跳重查 URL 与权限；跨来源重新生成请求头。
- Cookie 仅由浏览器在授权的源站请求中使用，不传给翻译后端或代理。缺少权限、HTTP 拒绝、资源过期和解码失败分别返回可操作原因。
- HTTP 请求保留 `no-store`，防止失败响应阻碍重试；成功字节由应用缓存管理。后台请求不保证复用网页 HTTP 缓存。
- Canvas 导出是像素重新编码，摘要可能与原文件不同；受污染画布不能导出。`activeTab` 不等于所有图片 CDN 的权限，`no-cors` 不提供可读字节。

## 验证

构建插件后，按[公共脚本环境](../scripts/README.md#来源与阅读验收)运行：

```powershell
node scripts/verify_image_transport.mjs
node scripts/verify_source_image_cache.mjs
```

检查 Referer、逐跳权限、跨来源请求头隔离、同 URL 并发、取消清理、失败重试和缓存恢复。页面资源另覆盖画布重绘、元素替换及导航失效；真实账户会话和浏览器原生权限需要独立验收。
