# 局部擦字与单页并行

2026-09-15。局部擦字与单页“文本翻译/擦字”并行均已实现，在隔离容器及独立 PostgreSQL 测试库验证，并已切换本地 Docker 服务。未进行公开部署。

## 局部擦字

旧实现把整页和文字掩膜交给 LaMa，长边超过 1024 时先缩小。掩膜限制最终改动位置，但模型仍计算整张缩放后的图片。

新实现见 [local_inpainting.py](../services/classic-engine/local_inpainting.py)，由 [server.py](../services/classic-engine/server.py) 的 `erase_page()` 调用：

1. 用文字掩膜生成邻近文字组，合并相互重叠的包围矩形，避免同一文字像素被多个区域重复写回。
2. 每组保留周围 48 像素背景。包含背景的单块输入长边上限为 512；过大的文字组继续切分，优先选择中部文字较少的位置。
3. 裁切中的所有文字掩膜一起传给 LaMa，避免把邻近文字当成修复背景。每块始终读取原图，只有归属该块的文字像素参与贴回。
4. 不自动回退整页推理。极小图片或文字覆盖全图时，某个裁切可能恰好等于原图，但仍遵守单块上限；大图被分成多个有背景上下文的小块。
5. 保留原有保护：未可靠识别的区域不擦除，掩膜外不改动；嵌字完成后再次验证原尺寸、字形和允许区域外的像素。

`classic_config.snapshot()` 包含 `inpainting_strategy=masked-crops-v1`、`inpainting_size=512`、`inpainting_padding=48`、`inpainting_merge_gap=24`。局部擦字首次使用 v2；拆分步骤并行后的引擎、后端默认版本和镜像版本统一为 `mit-95227a2-classic-v3-parallel`，使新结果与旧版缓存区分。模型、权重、字体和文本提示词不变。

裁切会改变 LaMa 的上下文和缩放比例，擦字区域内的输出不保证与旧版逐像素相同。文字密集页可能产生更多裁切，不能保证每页都更快；大型连续网点、拟声词和跨切分边界的复杂背景仍需扩大样例验证。

## 当前单页并行流程

检测、OCR、文字合并/排序、掩膜精化依次完成后，后端主线程处理文本组，另一个线程请求局部擦字：

```text
检测/OCR/掩膜完成
  ├─ 文本翻译：只依赖有序文本、目标语言和固定提示词 ─┐
  └─ 局部擦字：只依赖原图、掩膜和图像配置 ─────────┤
                                                  ↓
                                             嵌字 → 校验/保存
```

两路的输入互不依赖。保持相同输入、分组和配置，调整先后关系不改变各自的算法；仍不能保证非确定性的外部文本模型每次请求返回逐字相同的译文。若文本耗时 T、擦字耗时 I，这部分等待时间理论上可从 `T + I` 接近 `max(T, I)`，不减少两路计算总量。

| 阶段 | 判断 |
| --- | --- |
| 检测与 OCR | 有依赖：OCR 需要检测出的文字位置 |
| OCR 与最终掩膜精化 | 有依赖：掩膜使用识别成功的文本块，并排除未识别区域 |
| 文本翻译与局部擦字 | 已并行；远端网络等待与本地 CPU 推理重叠 |
| 多个文本组翻译 | 文本数据独立，但共享单页预算和重试记录。同时保守预占多组费用可能导致原本串行能完成的页面提前耗尽预算，不属于当前可直接替换且不影响交付的并行项 |
| 多个 LaMa 裁切 | 当前裁切读取同一份原图、写入互斥像素，数据上独立；本轮验证了改变处理顺序不影响模拟结果。但尚未验证真实模型并发、峰值内存与 CPU 争抢收益，保持串行 |
| 嵌字 | 依赖译文和清理图；当前逐块修改同一画布，且上游使用字体全局状态，不能直接并行替换 |
| 最终校验/保存 | 依赖完整合成图，保持顺序执行 |

引擎私有接口现在是 `analyze`、`inpaint`、`render`：`inpaint` 只接收原图、分析结果和图像配置，返回清理图；`render` 必须额外接收已经校验的清理图和译文，只执行嵌字，缺少清理图时报错，不隐式重新擦字。引擎锁仍串行执行图像任务；并行发生在后端文本网络请求与本地图像请求之间，不增加模型实例数或 CPU 推理线程数。

擦字检查点单独持久化到后端本地，继承原图用户、到期和删除规则。两路使用独立数据库会话，写入前检查执行权、取消、删除和到期；旧执行的晚到结果不能覆盖新任务。两路均成功才能嵌字和交付。文本失败后先等待已启动的本地擦字结束，不交付半成品；擦字失败后，在下一个文本组或文本重试前停止外部调用，已发出的请求仍完成计量并保留有效译文。两路都退出后才恢复或结算任务。嵌字失败时复用成功译文及清理图，已有文本调用计量与预算不重置。

任务阶段沿用 `translating_text`（两路运行）和 `inpainting_rendering`（文本完成后等待擦字/嵌字），产品 API 与界面不新增阶段类型。引擎 `render` 的请求上限提高到 128 MiB 以容纳原图、清理图和掩膜；每张解码图片仍受原有字节和像素限制。

## 验证

- 引擎 9 项自动化检查：局部输入尺寸、邻近合并、远处分离、稠密大区域、图片边缘、嵌套矩形、病态碎片掩膜、完整且唯一的像素归属、背景/原图保护、顺序独立、无字跳过及异常输出。
- 新增引擎 5 项步骤契约检查：擦字无需译文、嵌字使用清理图、缺失清理图不回退、拒绝旧引擎版本、不同图像步骤继续受同一把锁保护。
- 后端常规翻译、并行及文本适配 45 项测试通过，覆盖原有缓存、恢复、取消、预算、计量和权限契约，以及受控事件证明的两路重叠、合流、晚到输出和检查点复用；引擎响应由模拟数据替代。
- 独立 PostgreSQL 随机 schema 中完成 7 项相同并行场景及 1 项原有预算竞争检查，共 8 项通过，不使用产品数据。
- 后端全量回归 196 项通过、21 项显式跳过；本次相关的上述 8 项 PostgreSQL 检查另行启用并通过，其余未启用的 PostgreSQL 场景不算通过。
- 真实 CPU LaMa、FP32、4 线程，在独立无网络容器中读取已有样例与掩膜。两种路径交替各执行 3 次，以下为中位数，不含模型加载、OCR、LLM 和嵌字。

| 样例 | 整页原方案 | 局部裁切 | 擦字耗时减少 | 裁切数 |
| --- | ---: | ---: | ---: | ---: |
| 原创书店漫画 1024×1536 | 5.23 秒 | 3.55 秒 | 约 32% | 10 |
| 合成对白页 600×800 | 3.36 秒 | 1.05 秒 | 约 69% | 3 |

两条路径的擦字掩膜外 RGB 像素均与原图相同。已有清理图已做目视对照：主要对白完成擦除，局部填补纹理与全图结果有差异，部分白底区域仍有轻微浅色痕迹，不宣称两者质量完全相同。拆分步骤后的真实图像检查重新执行检测/OCR，只在文本编号与原文完全一致时复用历史译文，运行 `erase_page` 和 `render_page`，两张最终译图均与此前 v2 局部擦字版本逐像素一致。未调用文本供应商，未进行真实远端 LLM 与 LaMa 并行的端到端测速；上表是先前擦字算法对比，不是并行带来的提速数据。

统计记录：[局部擦字](evidence/classic-crops.json)、[单页并行](evidence/classic-parallel.json)。图片和完整原始记录分别在被忽略的 `private-test-data/classic-crops/`、`private-test-data/classic-parallel/` 中。

### 可重复命令（PowerShell）

要求已有 `node-comics-classic-engine:local` 镜像及下载完的 `node-comics_comics_models` 模型卷；测试通过只读挂载当前源码运行，不覆盖现有镜像或服务，不下载新组件。

```powershell
$cropEngine = (Resolve-Path services/classic-engine).Path
docker run --rm --network none --env ENGINE_VERSION=mit-95227a2-classic-v3-parallel --mount "type=bind,source=$cropEngine,target=/opt/engine,readonly" --workdir /opt/engine --entrypoint python node-comics-classic-engine:local -m unittest test_local_inpainting test_stage_contract -v
backend/.venv/Scripts/python.exe -m pytest backend/tests/test_classic.py backend/tests/test_classic_parallel.py backend/tests/test_text_adapter.py -q
```

真实检查需要先前生成的 `private-test-data/classic-smoke-v2/`、`classic-dialogue/`（原图、掩膜和私有 `stages.json`）。缺少这些样例时只执行上面的模拟检查，不重新请求付费翻译。

```powershell
$cropScripts = (Resolve-Path scripts).Path
$cropSamples = (Resolve-Path private-test-data).Path
New-Item -ItemType Directory -Force private-test-data/classic-parallel | Out-Null
$cropOutput = (Resolve-Path private-test-data/classic-parallel).Path
$cropArgs = @('run', '--rm', '--network', 'none',
  '--mount', "type=bind,source=$cropEngine,target=/opt/engine,readonly",
  '--mount', "type=bind,source=$cropScripts,target=/checks,readonly",
  '--mount', "type=bind,source=$cropSamples,target=/samples,readonly",
  '--mount', "type=bind,source=$cropOutput,target=/output",
  '--mount', 'type=volume,source=node-comics_comics_models,target=/models,readonly',
  '--env', 'PYTHONPATH=/opt/engine:/opt/mit',
  '--env', 'ENGINE_VERSION=mit-95227a2-classic-v3-parallel',
  '--workdir', '/opt/engine', '--entrypoint', 'python',
  'node-comics-classic-engine:local', '/checks/verify_classic_crops.py')
docker @cropArgs
docker @cropArgs render
```

PostgreSQL 检查沿用 [后端说明](../backend/README.md) 中独立测试库的准备要求；确认测试库已存在后执行：

```powershell
$parallelBackend = (Resolve-Path backend).Path
docker run --rm --network node-comics_default --env-file deploy/.env.local --env RUN_POSTGRES_CONCURRENCY=1 --env TEST_PG_HOST=postgres --mount "type=bind,source=$parallelBackend,target=/app,readonly" node-comics-backend:local python -m pytest tests/test_classic_parallel_postgres.py tests/test_postgres_concurrency.py::test_postgres_classic_budget_reservation_is_atomic -q -p no:cacheprovider --tb=short
```

## 本地服务切换

2026-09-15 已构建并启用新版后端与图像引擎镜像。切换前确认无排队、运行或结果未知的任务；暂停 API 后再次确认待执行任务为零，再停止调度器和 worker，更新引擎并等待健康，最后启动后端服务。PostgreSQL、Redis 与数据卷保持原实例。

- 图像引擎健康接口返回 `ready=true`、版本 `mit-95227a2-classic-v3-parallel`，API 健康接口正常，两个 Celery worker 均返回 `pong`。
- 经实际运行引擎的认证 HTTP 接口重新执行两张已有样例的检测、擦字与嵌字，复用已校验译文，结果与隔离验证版本逐像素一致。
- 无字页通过实际 API 提交并由调度器/worker 完成，状态 `no_text`、预占释放、文本调用数 0；任务持久化配置已是 v3。
- 保留切换前镜像标签 `node-comics-classic-engine:pre-parallel-20260915`、`node-comics-backend:pre-parallel-20260915`。后端使用源码只读挂载，回退还需要匹配的源码与引擎配置，不能只换镜像标签。

镜像标识与脱敏检查结果见[切换记录](evidence/classic-deployment.json)。后续切换仍需同步重建引擎并重启读取配置的后端服务；环境变量中若显式设置 `CLASSIC_ENGINE_VERSION`，需同步更新。不要在正在执行的旧任务中切换版本；旧配置任务会因版本不匹配被拒绝，新任务需要重新报价。
