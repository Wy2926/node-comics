import {ApiError} from '../api-error';
import {errorDetail} from '../error-detail';
import {msg} from '../i18n/runtime';

export function loginError(error:unknown){
  if(error instanceof ApiError)return errorDetail(error.code==='NETWORK_ERROR'?msg('暂时连接不到登录服务，请检查网络后重试。'):error.message,error.code,error.status);
  if(error instanceof Error&&error.name==='TimeoutError')return msg('请求超时，请检查服务是否可访问后重试。');
  // Parser and browser TypeErrors can quote a response body or a credential URL.
  if(error instanceof SyntaxError)return msg('登录服务返回的数据格式无效，请检查服务地址及版本。');
  if(error instanceof TypeError)return errorDetail(msg('登录未完成，请重试。'),error.name);
  return error instanceof Error&&error.message?error.message:msg('登录未完成，请重试。');
}

export function oidcFailure(code:unknown,status?:number,description?:unknown){
  let message:string;
  switch(code){
    case 'access_denied': message=msg('登录授权被拒绝，请确认账号有权访问后重新登录。');break;
    case 'login_required':case 'consent_required':case 'interaction_required':case 'account_selection_required':
      message=msg('请在安全登录页面完成授权');break;
    case 'invalid_grant': message=msg('登录授权码已失效或校验失败，请重新登录。');break;
    case 'invalid_request':case 'invalid_client':case 'unauthorized_client':case 'invalid_scope':case 'invalid_target':
    case 'unsupported_response_type':case 'invalid_redirect_uri':case 'redirect_uri_mismatch':
      message=code==='invalid_request'&&typeof description==='string'&&/origin .+ not allowed for client/i.test(description)
        ?msg('登录来源未获身份服务允许，请管理员在 Logto 应用的 Allowed CORS origins 中登记当前网页或插件来源。')
        :msg('身份服务尚未配置完整，请稍后重试或联系运营方。');break;
    case 'server_error':case 'temporarily_unavailable': message=msg('登录服务暂不可用');break;
    // Unknown OAuth fields may contain the authorization code or a private provider diagnostic.
    default:return Error(status?msg('登录授权码交换失败（HTTP {0}），请重新登录；若仍失败，请联系管理员检查身份服务配置。',{'0':status}):msg('身份服务未完成登录，请重试。'));
  }
  return Error(errorDetail(message,code,status));
}
