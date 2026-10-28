import {msg} from '../../../../i18n/runtime';
export function errorMessage(code:string):string{
  if(code==='MODEL_PUBLICATION_BLOCKED')return msg('上游发布材料尚未齐全，此资源暂不开放安装。');
  if(code.startsWith('ASSET_'))return msg('本地模型或字体尚未就绪，请在资源管理中下载或修复。');
  if(code==='TEXT_CONFIG_INVALID'||code==='TEXT_CONFIG_CHANGED')return msg('请检查正文服务地址、模型与参数，然后保存设置。');
  if(code==='TEXT_AUTH')return msg('正文服务鉴权失败，请检查网关访问令牌。');
  if(code==='TEXT_GOOGLE_UNAVAILABLE')return msg('谷歌翻译暂时无法连接或限制访问，请稍后手动重试，或切换正文翻译服务。');
  if(code==='TEXT_RATE_LIMIT')return msg('正文服务暂时限流，请稍后手动重试。');
  if(code==='TEXT_OUTCOME_UNKNOWN'||code==='INTERRUPTED')return msg('任务已中断；正文请求可能已产生费用，请确认后手动重试。');
  if(code.startsWith('TEXT_'))return msg('正文翻译未完成或响应无效；已成功批次保留，请检查服务后重试。');
  if(code.startsWith('FONT_'))return msg('所选字体无法完整显示译文，请更换字体。');
  if(code==='IMAGE_TOO_LARGE')return msg('此图片超过本机处理上限，请选择其他翻译渠道。');
  if(code==='SOURCE_MISSING'||code==='SOURCE_CHANGED')return msg('原图不可用，请恢复所属来源或本地原图缓存。');
  if(code==='RESULT_NOT_CACHED')return msg('本地译图缓存已清理，请手动重新翻译。');
  return msg('本机推理失败，请检查设备与模型资源后手动重试。');
}
