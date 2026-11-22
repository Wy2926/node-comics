import {msg} from '../../../../i18n/runtime';
export function localStageLabel(stage:string){
  return stage==='ocr'?msg('文字识别'):stage==='detect'?msg('文字位置检测'):stage==='preload'?msg('模型与字体'):stage==='load'?msg('准备原图')
    :stage==='bubble'?msg('对话气泡识别'):stage==='ocr_postfilter'?msg('文字识别过滤'):stage==='merge'||stage==='order'?msg('整理文字顺序')
    :stage==='inpaint'||stage==='mask_refine'?msg('原文清除与背景修复'):stage==='typeset'?msg('清理原文并排版'):stage==='finalize'?msg('生成译图'):undefined;
}
export function errorMessage(code:string):string{
  if(code==='ASSET_CORRUPT')return msg('资源校验失败，请重新下载。');
  if(code==='TEXT_STORAGE_FULL')return msg('空间不足');
  if(code==='LOCAL_HOST_EXTENSION_REQUIRED')return msg('请在已安装的浏览器插件中使用本机翻译。');
  if(code==='LOCAL_HOST_UNAVAILABLE')return msg('翻译执行页面无法打开，请重新尝试。');
  if(code==='LOCAL_BUSY')return msg('请等待当前翻译完成后重试。');
  if(code==='TEXT_LANGUAGE_UNSUPPORTED')return msg('此语言待支持，未启动本地翻译。');
  if(code.startsWith('ASSET_'))return msg('本地模型或字体尚未就绪，请在资源管理中下载或修复。');
  if(['TEXT_CONFIG_INVALID','TEXT_CONFIG_CHANGED','TEXT_HTTP_400','TEXT_HTTP_404','TEXT_HTTP_422'].includes(code))return msg('请检查正文服务地址、模型与参数，然后保存设置。');
  if(code==='TEXT_THINKING_REQUIRED')return msg('此模型强制思考，请选择思考程度或更换模型。');
  if(code==='TEXT_THINKING_INVALID')return msg('此模型不支持所选思考程度，请重新选择。');
  if(code==='TEXT_THINKING_BUDGET')return msg('输出上限需大于思考预算，请调整高级协议设置。');
  if(['TEXT_AUTH','TEXT_HTTP_401','TEXT_HTTP_403'].includes(code))return msg('正文服务鉴权失败，请检查 API Key 或网关访问令牌。');
  if(code==='TEXT_GOOGLE_UNAVAILABLE'||code.startsWith('TEXT_GOOGLE_HTTP_'))return msg('谷歌翻译暂时无法连接或限制访问，请稍后手动重试，或切换正文翻译服务。');
  if(code==='TEXT_RATE_LIMIT'||code==='TEXT_HTTP_429')return msg('正文服务暂时限流，请稍后手动重试。');
  if(code==='TEXT_OUTCOME_UNKNOWN'||code==='INTERRUPTED')return msg('任务已中断；正文请求可能已产生费用，请确认后手动重试。');
  if(code.startsWith('TEXT_'))return msg('正文翻译未完成或响应无效，请检查服务后重试。');
  if(code.startsWith('FONT_'))return msg('本地模型或字体尚未就绪，请在资源管理中下载或修复。');
  if(code==='SOURCE_MISSING'||code==='SOURCE_CHANGED')return msg('原图不可用，请恢复所属来源或本地原图缓存。');
  if(code==='RESULT_NOT_CACHED')return msg('本地译图缓存已清理，请手动重新翻译。');
  const stage=localStageLabel(code.replace(/^PIPELINE_/,'').replace(/_TIMEOUT$/,'').toLowerCase());
  const message=code.endsWith('_TIMEOUT')?msg('本机处理长时间无响应，请手动重试。'):msg('本机推理失败，请检查设备与模型资源后手动重试。');
  return stage?`${stage} · ${message}`:message;
}
