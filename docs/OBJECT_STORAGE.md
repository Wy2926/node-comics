# 译图对象存储（R2）

实现状态：代码支持 `local` 和 `r2`，默认 `local`。R2 通过 AWS Python SDK `boto3` 接入 S3 兼容协议，签名、HTTP 和存储请求重试由 SDK 处理。`ObjectStore` 隔离业务与存储，`S3Store` 可供后续其他兼容供应商复用；当前没有开放其他供应商的部署配置。

## 数据路径

- 原图仍由 API 接收、校验并保存到 `STORAGE_PATH`，供翻译使用。
- 启用 R2 后，新增 `redraw` / `classic` 译图和常规翻译中间图片直接从内存上传私有桶，不在服务器落盘。人工核实交付的本地图片也会先转存 R2。
- 用户带 Bearer 调用 `GET /v1/images/{id}/access`。API 核对所有者、原图状态、到期时间和对象存在性，返回短时 R2 GET 签名链接与 `authorization_required:false`。
- 插件直接从 R2 下载，省去 API 服务器的译图下载流量。下载不带账户 Bearer、Cookie 或 Referer；签名过期最多重新获取一次链接。图片仍解码为 Blob，沿用原有窗口加载、版本切换和阅读位置。
- `/content` 对 R2 图片只做授权后 307 跳转，不代理字节。本地图片继续使用同源 Bearer 下载。

服务器仍承担原图磁盘、原图上传、供应商通信、向 R2 上传一次结果和必要的检查点恢复流量，以及少量授权 / HEAD 元数据请求；重复阅读和用户下载译图的流量由 R2 承担。没有启用永久公开桶。

## 配置和启用

1. 在 Cloudflare 创建私有 R2 桶，保持 `r2.dev` 和公开域名访问关闭。
2. 创建限定到该桶的 **Object Read & Write** S3 凭据（Access Key ID 和 Secret Access Key）。需要读、写、删对象和列举前缀用于清理。
3. 将下列配置写入仓库根目录 `.env` 或部署秘密管理；API、两种 worker 和 dispatcher 必须使用相同值。

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

5. 重新构建并启动所有后端进程以安装依赖和应用配置，例如现有 Docker 启动入口：

```powershell
./scripts/bootstrap.ps1 -Start -Classic
```

只使用重绘时省略 `-Classic`。Compose 已把 `.env` 共享给后端进程；无需公开图片卷。启动自动运行 Alembic `0008`，为旧资产和 attempt 标注 `local` 并建立远端清理游标。

## 删除、恢复和切换

- 每个 Asset 记录存储后端，attempt 在领取时固定输出存储位置。切换默认配置只影响后续新结果，既有本地结果保留原位置，不自动迁移或删除。
- 从 R2 切回 `local` 时继续保留 R2 端点、桶、前缀和凭据，直到旧结果及未决任务全部过期/处理完毕。不能直接把同一个 `r2` 配置改指另一桶或前缀，否则已有对象无法定位。
- 写入 R2 成功而数据库未提交时，可按稳定 attempt key 找回结果；写入超时也先核实同一对象。R2 不可用时保留恢复状态；对象确实不存在时，重绘按既有 `outcome_unknown` 流程核实，绝不因此重发图片模型请求。
- 删除先提交数据库墓碑，再删本地/R2 对象。删除失败返回 503，墓碑继续拒绝新访问，由 dispatcher 重试；成功物理删除后已有直链也失效。删除故障期间，**此前签发的直链可能继续有效至签名到期**，默认最长约 5 分钟。
- 到期/删除资产分批物理清理。远端孤立对象每次最多扫描 200 个，游标持久化；扫完整个前缀后等待 1 小时。只删超过 24 小时、无资产记录且无运行/未决 attempt 引用的对象，不扫描其他前缀。
- 不在数据库、任务、默认日志或浏览器持久化签名链接；不要开启 `boto3` / `botocore` 的 HTTP DEBUG 日志。

## 验证

```powershell
backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_object_storage.py -q
npm --prefix apps/extension test -- tests/image-access.test.ts tests/concurrency.test.ts
npm --prefix apps/extension run check
```

后端专项测试使用临时 SQLite、SDK Stubber 和模拟 S3，覆盖两种模式交付、无本地译图、权限、过期、缺失/故障区分、崩溃恢复、重复结算保护及分页清理；前端测试覆盖登录令牌隔离、同源下载、链接更新和失败上限。这些不代表真实 R2 接入验证或新的翻译效果验证。

浏览器复测使用 `scripts/verify_r2_download.mjs`：先运行 `backend/tests/manual_ui_server.py`（隔离数据库、合成图片和模拟翻译供应商），再在另一终端运行 `npm --prefix apps/extension run dev -- --port 5174`。把 fixture 输出的临时目录赋给 `UI_FIXTURE_DIRECTORY`，安装了 Playwright 的运行时模块路径赋给 `PLAYWRIGHT_MODULE`，执行 `node scripts/verify_r2_download.mjs`。脚本用 Chrome 检查实际阅读器，模拟 R2 直链及一次 403，校验无账户请求头、自动更新链接、保留当前页和继续翻页；结果与截图写入 `artifacts/r2-validation/`。仅测试代码代管模拟对象响应，不调用真实 R2。

2026-09-15 本地验证：前端 159 项测试、类型/模块检查、Chrome MV3 和 Web 构建通过；后端 177 项通过，14 项需独立 PostgreSQL 的并发用例未启用。Chrome 上述 3 项阅读器检查及截图复核通过。随后已使用用户提供的 R2 配置完成真实桶验收：SDK 上传/HEAD/读取、签名下载与解码、指定来源 CORS、删除后撤销直链均通过，合成测试对象已清理。Chrome 也通过真实 R2 CORS 下载检查，证据位于 `artifacts/r2-validation/live-results.json` 与 `live-r2-chrome.png`。

本地 `.env` 已启用 R2 并使用独立部署前缀，凭据未进入 Git；本地 API、dispatcher、两种 worker 已重新构建启动，PostgreSQL 已迁移到 `0008`。容器内使用临时 SQLite、合成图片和模拟供应商验证了实际 worker → R2 → 授权直链交付，以及无本地译图、重复结算保护和删除；未调用真实图片模型，未发布到公网。已有本地译图继续保留原位置。

可重复的真实存储检查命令（均只创建并清理合成测试对象）：

```powershell
backend/.venv/Scripts/python.exe scripts/probe_r2.py
# 可追加 --cors-origin 验证来源；只有显式 --configure-cors 才合并写入桶规则。
```

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
