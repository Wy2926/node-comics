# 原图与译图对象存储（R2）

2026-09-15：原图与最终 `classic` / `redraw` 结果统一使用私有 R2。公开部署不允许本地持久原图；隔离测试才可设置 `DEV_AUTH=true` 与 `RESULT_STORAGE_BACKEND=local`。真实 R2 新链路与模拟 S3／SDK 检查分别记录于[集群验收](CLUSTER_VALIDATION.md)。

## 数据路径

- 原图先取得用户/模式容量内的有限上传会话。API 按实际字节上限接收至内存，写 R2 临时对象；complete 指令排入后台校验，不把客户端声明直接视为有效图片。
- 校验任务核对同一缓冲的摘要、大小、格式和解码尺寸，写不可变原图对象，再提交资产、引用保护和阶段状态。未校验图不可作为其他任务输入。
- 计算代理通过控制 API 的当前租约读取输入，无 R2 凭据。常规清理图只存节点有界内存缓存，OCR/遮罩检查点和译文存数据库。
- 最终结果先固定租约的结果摘要，再写独立租约键；数据库提交前失联可按该键恢复。原图和译图长期存储不占服务器磁盘。默认不自动删除有效原图或译图。
- 用户通过 `GET /v1/images/{id}/access` 获得短时签名下载链接；签名、列表、状态与缓存匹配不发送远端 HEAD。
- 浏览器直连 R2 下载原图/译图，不带账户 Bearer、Cookie 或 Referer；签名过期可刷新一次。API `/content` 对 R2 只授权后跳转。

服务器仍承担上传接收、校验读写和节点输入传输。这里解决持久磁盘与跨机器共享文件问题，暂未承诺消除所有 API 带宽。R2 临时上传使用独立键，验证后才能成为有效资产；正常状态查询不探测远端对象。

## 配置和启用

1. 在 Cloudflare 创建私有 R2 桶，保持 `r2.dev` 和公开域名访问关闭。
2. 创建限定到该桶的 **Object Read & Write** S3 凭据（Access Key ID 和 Secret Access Key）。需要读、写、删对象和列举前缀用于清理。
3. 将下列配置写入仓库根目录 `.env` 或部署秘密管理；API、control-worker 和 maintenance 必须使用相同值。

```dotenv
RESULT_STORAGE_BACKEND=r2
R2_ENDPOINT_URL=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_BUCKET=node-comics-private
R2_ACCESS_KEY_ID=<ACCESS_KEY_ID>
R2_SECRET_ACCESS_KEY=<SECRET_ACCESS_KEY>
R2_KEY_PREFIX=node-comics/
STORAGE_URL_TTL_SECONDS=300
STORAGE_TIMEOUT_SECONDS=30
```

`R2_ENDPOINT_URL` 使用桶设置中的 S3 API 账户端点；支持默认、EU 和 FedRAMP 域名，不接受公开桶域名或附加路径。R2 的签名区域固定 `auto`。`R2_KEY_PREFIX` 必须非空、以 `/` 结尾，并由当前部署独占；不同数据库/环境使用不同前缀。不要把这些凭据写入插件或 `VITE_` 变量。

直链有效期可配置 1–3600 秒，默认 300 秒，并截短至图片到期时间。网络连接与读取超时默认 30 秒，SDK 标准重试最多共 3 次；重试对象 PUT 使用相同 key，不重复发起翻译或结算。

4. 在桶设置添加 CORS，填入实际 Web 阅读器地址和插件 ID，例如：

```json
[
  {
    "AllowedOrigins": [
      "https://reader.example.com",
      "chrome-extension://替换为实际扩展ID"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "ExposeHeaders": ["Content-Type", "Content-Length", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

本地 Web 验证时单独加入实际 `http://127.0.0.1:端口`。插件从自己的页面发起跨域下载，不需要新增覆盖全部 R2 的主机权限。R2 过期签名响应可能没有 CORS 头，因此客户端也对首次网络/CORS 失败刷新一次链接。

5. 配置后使用新集群启动入口，见[后端说明](../backend/README.md)。原图不挂载持久图片卷；模型权重卷独立保留。新 `nodes_0001` 基线需要空数据库，不迁移旧资产位置。

## 删除、保留与恢复

- 活跃任务通过 `active_references` 保护原图，即使自然保留期已到也不回收；任务终态只释放一次引用。
- 原图与最终译图默认 `expires_at=null`，无限期保留，翻译完成不删除。`last_accessed_at` 记录最近签发授权访问的时间；当前没有长期未访问自动删除任务，不逐次统计 R2 GET。未来显式期限策略不能让仍有效的译图失去父原图。
- 删除先提交数据库墓碑、任务取消/丢弃和增量状态，再访问 R2 DELETE；删除失败由维护进程重试。已签发直链可能继续有效至签名到期。
- 对象存储写入成功但 DB 提交失败时，按 ExecutionLease 对象键恢复。已写图片模型调用意图的任务不因存储故障而重新调用模型。
- 孤儿扫描限定本部署前缀并保存游标；保护当前资产、活跃/未决租约和上传对象，只清理超过宽限时间的无引用对象。不扫描其他部署前缀。
- 默认日志和持久化记录不保存签名链接、用户图片字节、OCR全文或存储请求秘密。不要开启 SDK HTTP DEBUG 日志。

## 验证

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_upload_storage.py backend/tests/test_cluster_submissions.py backend/tests/test_object_storage.py -q
# 显式真实R2验收：读取给定配置，独立临时DB、合成图和随机测试前缀。
backend/.venv/Scripts/python.exe scripts/verify_cluster_r2.py --env-file .env
```

实际参数以脚本 `--help` 为准。R2 脚本只调用存储，不调用付费模型，退出时仅删除本次随机前缀内测试对象并确认清空。没有配置时明确输出 `not_verified`，不以模拟结果替代实际接入证据。此前旧存储链路的验收记录不能证明本次新上传协议已在线验证。

## SDK 版本与许可

来源为 [PyPI boto3](https://pypi.org/project/boto3/1.43.94/)，版本固定在 `backend/requirements.txt`。以下为本次安装的 wheel SHA-256；许可核对实际 wheel 内的 LICENSE，未引入模型权重或字体。

| 包 | 版本 | 许可 | wheel SHA-256 |
| --- | --- | --- | --- |
| boto3 | 1.43.94 | Apache-2.0 | `2534bf331acd2f448b9cf8317f4eed453c65d9e0b7de254e77c99d390ac57aec` |
| botocore | 1.43.94 | Apache-2.0 | `1dfb86603a87fdaebda2540db56aef5b226ec58ab72c13ca56737e4d66dea9ab` |
| s3transfer | 0.19.2 | Apache-2.0 | `d8168eccca828cbb2cd573675333f3bddd254313a9c42494b84c76b539e8ba25` |
| jmespath | 1.1.0 | MIT | `a5663118de4908c91729bea0acadca56526eb2698e83de10cd116ae0f4e97c64` |
| urllib3 | 2.7.0 | MIT | `9fb4c81ebbb1ce9531cce37674bbc6f1360472bc18ca9a553ede278ef7276897` |
| python-dateutil（已有） | 2.9.0.post0 | Apache-2.0 / BSD-3-Clause（按文件贡献区分） | `a8b2bc7bffae282281c8140a97d3aa9c14da0b136dfe83f850eea9a5f7470427` |
| six（已有） | 1.17.0 | MIT | `4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274` |

协议依据：[Cloudflare boto3 示例](https://developers.cloudflare.com/r2/examples/aws/boto3/)、[签名链接](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[桶 CORS](https://developers.cloudflare.com/r2/buckets/cors/)。
