# 节点直传 R2 验证记录

2026-09-19，提交前本地回归。实现范围与信任边界见[计算协议](COMPUTE_PROTOCOL.md#7-结果交付节点并发直传-r2)；中心核对租约、结果摘要和上传回执，可信自管节点负责最终图片，不在中心重新验收像素。

## 命令与结果

| 工作目录 | 命令 | 结果 |
| --- | --- | --- |
| `backend` | `.venv/Scripts/python.exe -m pytest tests -q` | 528 passed，101 skipped；2 项依赖弃用警告 |
| `services/classic-engine` | `.venv-ncnn/Scripts/python.exe -m pytest -q` | 74 passed |
| `backend/admin-ui` | `npm run build` | TypeScript 检查与 Vite 构建通过 |
| `backend/admin-ui` | `npm test` | 5 passed |
| 仓库根目录 | `git diff --check` | 通过 |

当时测试使用宿主机虚拟环境及前端依赖；这些本机环境现已移除，当前命令见[后端验证](../backend/README.md#验证)和[节点验证](../services/classic-engine/README.md#验证)。覆盖上传签名约束、目标来源与凭据隔离、上传回执丢失后重试、并发上传释放计算线程、冻结结果重启恢复、重复交付结算、旧代次与取消隔离，以及最终 PNG 摘要和原图 alpha 保留。对象存储与文本调用使用隔离适配器或固定回复。

## 未验证范围

本次未启用 PostgreSQL 专用并发库、真实模型 Vulkan 验收或负载测试；后端跳过项以测试各自的环境开关为准。未执行真实 R2 直传、付费 LLM 调用、后台浏览器视觉验收、Linux／NVIDIA 验收或生产部署。构建通过不代表这些外部流程通过。此前性能记录见[流水线改造验收](PIPELINE_VALIDATION.md)，不能作为当前直传版本的新性能结果。
