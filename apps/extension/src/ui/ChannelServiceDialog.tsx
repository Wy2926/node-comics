import {useEffect,useId,useRef,useState} from 'react';
import {Icon} from '../icons';
import {msg} from '../i18n/runtime';
import {ChannelServiceError,type ChannelServiceSelection,type ServiceResponse} from '../translation/channels/contracts';
import {ChannelFields} from './ChannelFields';
import {Modal} from './components';
import {ServiceModelInput} from './ServiceModelInput';
import './channel-service-dialog.css';

type Action='models'|'test'|'save';
function ResponseDetails({response}:{response:ServiceResponse}){
  const [open,setOpen]=useState(false),[full,setFull]=useState(false);
  // 大模型目录只在用户明确展开后渲染；保留已读取的尾部，方便核对用量、结束原因。
  const partial=!full&&response.body.length>8192;
  return <details className="nc-service-response" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{msg('实际响应')}</summary>
    {open&&<>
      <pre tabIndex={0} aria-label={msg('实际响应')}>{partial?response.body.slice(0,8192):response.body||msg('响应正文为空。')}</pre>
      {(partial||response.truncated)&&<small>{msg('仅显示部分响应。')} {partial&&<button type="button" className="text-link" onClick={()=>setFull(true)}>{msg('查看全部')}</button>}</small>}
    </>}
  </details>;
}
export function ChannelServiceDialog({services,serviceId,language,onClose}:{services:ChannelServiceSelection;serviceId?:string;language:string;onClose:()=>void}){
  const original=services.items.find(item=>item.id===serviceId);
  const [values,setValues]=useState(original?.values??services.initialValues),[models,setModels]=useState<string[]>();
  const [busy,setBusy]=useState<Action>(),[error,setError]=useState(''),[invalid,setInvalid]=useState<string>(),[sample,setSample]=useState('');
  const [response,setResponse]=useState<ServiceResponse>(),[lastAction,setLastAction]=useState<Action>();
  const request=useRef<AbortController>(null),form=useRef<HTMLFormElement>(null),result=useRef<HTMLElement>(null),id=useId();
  const fields=services.fields(values),model=fields.find(field=>field.key==='model')!;
  const common={values,onChange:change,disabled:busy==='save',invalid},saved=values.baseUrl===original?.values?.baseUrl?original?.savedSecrets:undefined;
  useEffect(()=>()=>request.current?.abort(),[]);
  useEffect(()=>{
    if(!sample&&(!error||invalid))return;
    // 窄屏时只滚动弹窗正文。字段错误保留输入焦点，修正建议随底栏保持可见。
    const pane=form.current?.closest<HTMLElement>('.nc-modal-body');
    if(pane&&result.current)pane.scrollTop+=Math.max(0,result.current.getBoundingClientRect().bottom-pane.getBoundingClientRect().bottom);
  },[sample,error,invalid]);

  function stop(){
    request.current?.abort();request.current=null;setBusy(undefined);
  }
  function change(input:Record<string,string>){
    const next=services.changeValues(values,input);
    // 地址、协议或凭据变更后，旧列表和迟到的请求均不能回填新表单。
    if(['baseUrl','token','llmProvider','protocol'].some(key=>next[key]!==values[key]))setModels(undefined);
    stop();setValues(next);setError('');setInvalid(undefined);setSample('');setResponse(undefined);setLastAction(undefined);
  }
  function close(){if(busy!=='save'){stop();onClose();}}
  async function run(action:Action){
    if(request.current)return;
    const controller=new AbortController();request.current=controller;
    setBusy(action);setError('');setInvalid(undefined);setSample('');setResponse(undefined);setLastAction(action);
    // 只保留当前操作最后一次 HTTP 回包；新草稿、关闭或取消之后不接受迟到的正文。
    let received:ServiceResponse|undefined;
    const inspect=(value:ServiceResponse)=>{received=value;};
    try{
      if(action==='save'){await services.save(values,serviceId);if(!controller.signal.aborted)onClose();}
      else if(action==='models'){
        const ids=await services.listModels(values,serviceId,controller.signal,inspect);
        if(!controller.signal.aborted)setModels(ids);
      }else{
        const text=await services.test(values,serviceId,language,controller.signal,inspect);
        if(!controller.signal.aborted)setSample(text);
      }
    }catch(reason){
      if(controller.signal.aborted)return;
      setError(reason instanceof Error?reason.message:msg('设置未保存，请重试。'));
      const field=reason instanceof ChannelServiceError?reason.field:undefined;
      setInvalid(field);
      if(field){
        const input=form.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`),group=input?.closest('details');
        if(group)group.open=true;
        // 保存失败时控件刚解除禁用；下一帧再聚焦，避免丢失错误定位。
        requestAnimationFrame(()=>{if(input?.isConnected)input.focus();});
      }
    }finally{if(request.current===controller&&!controller.signal.aborted){request.current=null;setBusy(undefined);setResponse(received);}}
  }
  const waiting=busy==='models'||busy==='test',connectionKeys=['llmProvider','name','protocol','baseUrl','token'],address=fields.find(field=>field.key==='baseUrl');
  return <Modal className="nc-service-dialog" icon="translate" title={serviceId?msg('编辑供应商'):services.addLabel} onClose={close} footer={
    <>
    {invalid&&<p id={id+'-error'} className="error nc-service-field-error" role="alert">{error}</p>}
    <div className="nc-service-actions">
      <button type="button" className="button secondary" disabled={busy==='save'} onClick={waiting?()=>{stop();setLastAction(undefined);}:()=>void run('test')}>
        <Icon name={waiting?'close':'translate'} size={16}/>{waiting?msg('停止请求'):msg('测试翻译')}
      </button>
      <button type="button" className="button secondary" disabled={busy==='save'} onClick={close}>{msg('取消')}</button>
      <button type="submit" form={id} className="button primary" disabled={!!busy}>{busy==='save'?msg('正在保存…'):msg('保存并使用')}</button>
    </div></>}>
    <form id={id} ref={form} className="nc-service-form" noValidate aria-busy={!!busy} aria-describedby={invalid?id+'-error':undefined} onSubmit={event=>{event.preventDefault();void run('save');}}>
      <div className="nc-service-sections">
        <section className="nc-service-card" aria-labelledby={id+'-connect'}>
          <h3 id={id+'-connect'}><span aria-hidden="true">01</span>{msg('连接设置')}</h3>
          <ChannelFields {...common} fields={fields.filter(field=>!field.advanced&&connectionKeys.includes(field.key))} saved={saved}/>
          {address?.advanced&&<details className="nc-service-advanced"><summary>{address.label}</summary><ChannelFields {...common} fields={[address]}/></details>}
        </section>
        <section className="nc-service-card" aria-labelledby={id+'-model-title'}>
          <h3 id={id+'-model-title'}><span aria-hidden="true">02</span>{msg('翻译模型')}</h3>
          <ServiceModelInput field={model} value={values.model??''} models={models} disabled={busy==='save'} busy={!!busy} invalid={invalid==='model'}
            onChange={model=>change({...values,model})} onFetch={()=>void run('models')}/>
          <ChannelFields {...common} fields={fields.filter(field=>!field.advanced&&field!==model&&!connectionKeys.includes(field.key))}/>
          <details className="nc-service-advanced"><summary>{msg('自定义提示词')} · {msg('高级协议设置')}</summary>
            <p className="nc-muted">{msg('一般无需修改。仅在服务要求特定参数时调整。')}</p>
            <ChannelFields {...common} fields={fields.filter(field=>field.advanced&&!connectionKeys.includes(field.key))}/>
          </details>
        </section>
      </div>
      {(!invalid||response)&&<section ref={result} className="nc-service-result" data-tone={error?'error':sample?'success':undefined} aria-label={msg('请求结果')}>
        <header><strong><Icon name="message" size={16}/>{lastAction==='models'?msg('获取模型'):lastAction==='test'?msg('测试翻译'):msg('请求结果')}</strong>
          {response&&<code>HTTP {response.status}</code>}
        </header>
        {error?!invalid&&<p role="alert" className="error">{error}</p>:<p role="status">{waiting?(busy==='test'?msg('正在测试翻译…'):msg('加载中…'))
          :sample?<><b>{msg('测试成功')}</b>{' · '}{sample}</>:lastAction==='models'&&models?msg('已获取 {count} 个模型',{count:models.length}):msg('保存前可用示例文本测试翻译。')}</p>}
        {response&&<ResponseDetails response={response}/>}
      </section>}
    </form>
  </Modal>;
}
