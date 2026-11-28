import {msg} from '../../../../i18n/runtime';
import {errorDetail} from '../../../../error-detail';
import {ChannelServiceError} from '../../contracts';
import {TextError} from './text/protocol';
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
  if(code==='TEXT_CONFIG_CHANGED')return msg('配置已更改，请重新打开供应商设置。');
  if(code==='TEXT_URL_INVALID')return msg('请输入有效的 HTTP 或 HTTPS 服务地址。');
  if(code==='TEXT_URL_PRIVATE')return msg('服务地址不能包含凭据、查询参数或片段。');
  if(code==='TEXT_URL_METHOD')return msg('可使用官方地址或自定义网关，填写接口前缀，不含具体请求方法。');
  if(code==='TEXT_MODEL_INVALID')return msg('填写服务中可用的模型名称');
  if(code==='TEXT_MODEL_NOT_FOUND')return msg('找不到此模型。请获取模型列表或核对模型 ID。');
  if(code==='TEXT_MAX_TOKENS')return msg('输出上限必须为正整数。');
  if(code==='TEXT_TEMPERATURE')return msg('随机程度必须在 0 到 2 之间。');
  if(code==='TEXT_HTTP_404')return msg('未找到接口或模型，请核对服务地址和模型 ID。');
  if(code==='TEXT_CONFIG_INVALID'||code==='TEXT_HTTP_400'||code==='TEXT_HTTP_422')return msg('请检查正文服务地址、模型与参数，然后保存设置。');
  if(code==='TEXT_BUDGET_INVALID')return msg('思考预算必须为正整数。');
  if(code==='TEXT_AUTH'||code==='TEXT_HTTP_401')return msg('正文服务鉴权失败，请检查 API Key 或网关访问令牌。');
  if(code==='TEXT_HTTP_403')return msg('服务拒绝访问。请检查 Key 的权限和供应商的访问限制。');
  if(code==='TEXT_HTTP_402'||code==='TEXT_QUOTA')return msg('供应商额度不足，请检查余额或账单。');
  if(code==='TEXT_NETWORK')return msg('无法连接服务，请检查地址、网络和浏览器访问权限。');
  if(code==='TEXT_TIMEOUT'||code==='TEXT_HTTP_408'||code==='TEXT_HTTP_504')return msg('请求超时，请检查服务是否可访问后重试。');
  if(/^TEXT_HTTP_5\d\d$/.test(code))return msg('翻译服务处理失败，请检查服务后手动重试。');
  if(code==='TEXT_OUTPUT_TRUNCATED')return msg('译文达到输出上限，请调高最大输出 Token 或降低思考程度。');
  if(code==='TEXT_PARAMETER_UNSUPPORTED')return msg('模型不支持某个请求参数，请核对高级设置或更换模型。');
  if(code==='TEXT_OUTPUT_INVALID'||code==='TEXT_OUTPUT_LIMIT')return msg('未收到完整的译文 JSON，请检查模型、响应格式和输出上限。');
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

const errorFields:Record<string,string>={
  TEXT_URL_INVALID:'baseUrl',TEXT_URL_PRIVATE:'baseUrl',TEXT_URL_METHOD:'baseUrl',TEXT_MODEL_INVALID:'model',TEXT_MODEL_NOT_FOUND:'model',
  TEXT_AUTH:'token',TEXT_HTTP_401:'token',TEXT_BUDGET_INVALID:'thinkingBudget',
  TEXT_MAX_TOKENS:'maxTokens',TEXT_OUTPUT_TRUNCATED:'maxTokens',TEXT_TEMPERATURE:'temperature',
};
export function serviceError(error:unknown,models=false){
  const code=error instanceof Error?error.message:'TEXT_CONFIG_INVALID';
  const message=models&&(code==='TEXT_HTTP_404'||code==='TEXT_HTTP_405'||code==='TEXT_HTTP_501')?msg('未找到模型列表接口。请核对服务地址，或手动填写模型 ID。')
    :models&&['TEXT_MODELS_INVALID','TEXT_OUTPUT_INVALID','TEXT_OUTPUT_LIMIT'].includes(code)?msg('模型列表格式无效。请检查接口协议，或手动填写模型 ID。')
    :errorMessage(code==='TEXT_OUTCOME_UNKNOWN'?'TEXT_NETWORK':code.startsWith('TEXT_')?code:'TEXT_CONFIG_INVALID');
  return new ChannelServiceError(errorDetail(message,undefined,error instanceof TextError?error.status:undefined),errorFields[code]);
}
