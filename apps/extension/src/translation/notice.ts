import type {TranslationState} from './automatic';

/** In-image notices stay short; diagnostic details are available on hover. */
export function translationNotice(state:TranslationState){
  let message=state.message;
  if(state.kind==='error'){
    message=/核实|未知/.test(state.message)?'结果待核实'
      :state.retryLabel?'加载失败'
      :/连接|网络|NETWORK|fetch/i.test(state.message)?'连接失败'
      :/原图|本地图片/.test(state.message)?'原图不可用'
      :state.retryable===false?'暂不可用':'翻译失败';
  }else if(state.kind==='login')message='登录后翻译';
  else if(state.kind==='upgrade')message='额度不足';
  const action=state.kind==='error'&&state.retryable!==false?'重试':state.kind==='upgrade'?'升级':undefined;
  return {message,action,label:action?`${message} · ${action}`:message,detail:state.message};
}
