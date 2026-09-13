# AI图片翻译与格式验证

2026-09-13。只研究用户确认的AI图片翻译链路。

## 协议依据

| 来源 | 约束 |
| --- | --- |
| [OpenAI图片编辑](https://developers.openai.com/api/reference/resources/images/methods/edit) | multipart，兼容供应商独立profile |
| [图片指南](https://developers.openai.com/api/docs/guides/image-generation) | 参数、文字与画面一致性需实测，保留原图 |
| [MV3生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | 后端持久任务 |
| [跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) | 按需图片域名权限、获取失败恢复 |
| [MV3远程代码](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code) | 适配器随插件发布 |
| [WXT入口](https://wxt.dev/guide/essentials/entrypoints.html) | popup/background/reader共享工程 |
| [KindleUnpack格式字段](https://github.com/kevinhendricks/KindleUnpack/blob/master/lib/mobi_header.py) | 参考格式字段，独立实现有界MOBI图片提取，不执行HTML |
| [Celery任务](https://docs.celeryq.dev/en/stable/userguide/tasks.html) | 数据库状态与账本提供业务幂等 |

## 样本与证据

原创samples/starlight-bookshop.png包含英文气泡和背景文字，用于实际译图对照。样本生成信息见 [说明](../samples/README.md)。

用户本地MOBI共221,624,973字节、正文194页，193张JPEG和末页GIF。按正文recindex确定顺序，附加缩略图和其他版本不加入。解析数据见 [证据](evidence/mobi-import.json)。私有书籍和提取结果不进入仓库或发布包。目录中同名EPUB的存在不代表已经实现EPUB导入。

真实测试记录模型配置、请求形状、状态、request ID、耗时、usage或未知标记、图片尺寸；不写Key、签名URL或完整漫画正文。检查译文、漏译、背景文字、画面变化、字号溢出与比例。生成样例不能证明所有日文漫画的质量，未测组合不能称已通过。

## 故障验证

重复操作／队列消息、客户端关闭、Worker中断、限流、未知结果、错误Base64、非图片响应、尺寸超限、过期、删除与两用户隔离。上游结果不明时停止重发是预期行为。模拟验证状态与结算，真实图片验证效果，分别报告。
