import {msg,messageSource} from '../i18n/runtime';
import type {TranslationState} from './automatic';

/** In-image notices stay short; diagnostic details are available on hover. */
export function translationNotice(state:TranslationState){
  let message=state.message;
  if(state.kind==='error'){
    const source=messageSource(state.message);
    message=/网站访问权限已被浏览器关闭|图片域名.*授权|网页与图片访问权限/.test(source)?msg('网站访问受限')
      :/核实|未知/.test(source)?msg("结果待核实")
      :state.retryLabel?msg("加载失败")
      :/连接|网络|NETWORK|fetch/i.test(source)?msg("连接失败")
      :/原图|本地图片/.test(source)?msg("原图不可用")
      :state.retryable===false?msg("暂不可用"):msg("翻译失败");
  }else if(state.kind==='login')message=msg("登录后翻译");
  else if(state.kind==='upgrade')message=msg("额度不足");
  const action=state.kind==='error'&&state.retryable!==false?(state.retryAction==='translate'?msg('重新翻译'):msg("重试")):state.kind==='upgrade'?msg("升级"):undefined;
  return {message,action,label:action?`${message} · ${action}`:message,detail:state.message};
}
