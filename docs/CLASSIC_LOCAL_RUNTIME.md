# 本机真实常规翻译服务

2026-09-19 已启动分阶段流水线，使用新数据库与节点状态目录，通过真实 R2、AMD Vulkan 和固定文本回复的四页交付验证，见[流水线验收](PIPELINE_VALIDATION.md)。本机入口只绑定 loopback，使用开发登录；美国 VPS 尚未切换本次代码。改造前的在线文本模型验证单独保留在下方。

## 启动

准备 Docker Desktop、`backend/.venv` 的后端依赖，以及 [classic-engine](../services/classic-engine/README.md) 的 `.venv-ncnn`、模型和字体。根 `.env` 提供实际 R2 与兼容供应商地址、密钥；`deploy/.env.local` 提供本机数据库密码和开发登录签名密钥。首次缺少后者时先运行 `scripts/bootstrap.ps1`。

```powershell
# 仓库根目录；本次用户确认使用此文本模型
./scripts/start-local-classic.ps1 -TextModel gpt-5.6-luna
# 查看健康状态与日志
backend/.venv/Scripts/python.exe scripts/local_classic.py ready
docker ps --filter label=com.docker.compose.project=node-comics-classic-local
Get-Content data/classic-local/node.stderr.log -Tail 30
```

脚本预热图像引擎，生成本机 TLS 证书，启动独立 Compose 项目 `node-comics-classic-local`，通过管理 API 配置文本供应商和节点，最后检查服务就绪。本次文本使用 `responses` 协议；可用 `-TextProtocol chat_completions` 显式选择另一协议。

| 服务 | 入口或配置 |
| --- | --- |
| 用户 API 与管理后台 | `http://127.0.0.1:18088`；后台完整路径由脚本输出 |
| 节点控制 API | `https://127.0.0.1:18443` |
| PostgreSQL、工作进程、维护进程 | Compose 内部网络，数据库不发布主机端口 |
| AMD 节点 | 隐藏后台进程，PID 在 `data/classic-local/node.pid` |
| 节点容量 | 8 个整页执行位，2 个计算步骤，下载／交付各 4 个线程；页面缓冲预算 1 GiB、恢复日志 512 MiB |
| 图像配置 | 日文 MIT FP32 OCR、Vulkan；目标简／繁中文、英、日、韩 |

Docker 服务设置 `restart: unless-stopped`。Windows 节点在当前会话持续运行，重启电脑后再次执行启动脚本；脚本检查 PID，避免重复启动。存在未完成页时不要更换模型／字体或删除节点恢复日志。

## 配置与数据

本机 PostgreSQL 使用独立持久卷，新库为 `nodecomics_pipeline_20260919`，schema 为 `shared_0007_upload_verified_info`。未导入旧任务或配置，旧库不再接入当前服务。R2 使用根 `.env` 前缀下的 `classic-local/`，原图与最终图继续按产品规则保留。启动不修改 VPS 数据库，不删除旧卷或远端对象。

`deploy/.env.classic-local` 保存本机环境和实际引擎版本；`services/classic-engine/node.local.json` 保存节点身份；`data/classic-local/tls/` 保存证书及私钥；当前 `services/classic-engine/state-pipeline/` 保存有界恢复日志。这些内容均被 Git 忽略。节点配置不含数据库密码、R2 长期密钥或文本供应商密钥。

节点通过 `control_ca` 显式信任本机证书，仍校验证书和主机名；不安装系统全局信任，不关闭 TLS 验证。R2 使用独立客户端和公共 CA，不接收控制凭据或本机信任文件。

控制服务只绑定 IPv4。实测通过 `localhost` 新建 HTTPS 连接约需 2.04 秒，使用 `127.0.0.1` 为 5–6 毫秒；启动器与节点均已固定为后者，证书 SAN 包含该地址。

启动器通过管理 API 把 `.env` 的供应商地址／密钥写入本机文本供应商版本。服务端仍按 DB 版本调用，不新增环境变量 seed。常规文本使用 `gpt-5.6-luna`，原 `gpt-image-2` 重绘配置保留。费率为 `operator-estimate-v1` 管理员估值，不代表供应商账单单价。

## 改造前的在线文本验证记录

使用生成的 720×600 日文对白样张，目标简体中文；通过正式提交、上传校验、节点 R2 直读、OCR、在线翻译、AOT 抹字、嵌字、中心像素验收、R2 写入及授权下载完整执行。

| 记录 | 结果 |
| --- | --- |
| 数据库迁移 | `shared_0006_compute_v2` |
| GPU | AMD Radeon RX 6900 XT，Vulkan |
| 文本调用 | `gpt-5.6-luna`，1 次，约 3.03 秒 |
| 上游返回用量 | 输入 4476、输出 23 tokens |
| 提交至成功终态 | 约 10.19 秒，包含上传校验、排队、文本等待与持久交付 |
| 存储与下载 | 原图／译图均为真实 R2，译图重新 GET 并解码成功 |
| 输出 | 720×600 PNG、31538 字节，排版与译文检查通过 |
| 用户隔离 | 其他用户无法签发此译图访问 URL |

单张样张耗时不是多页吞吐基准，也不代表自然漫画 OCR 准确率。脱敏记录及译图在本机 `artifacts/classic-live/`；凭据、签名 URL 和图片文字不进入默认日志或版本控制。其他测试见 [v2 实施说明](COMPUTE_V2_IMPLEMENTATION.md)。
