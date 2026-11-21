import {msg} from '../i18n/runtime';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Api} from '../api';
import {API_BASE,API_ORIGIN} from '../service';
import {requireHostAccess} from '../host-permissions';
import {finishOidc,isOidcCallback,startOidc,type AuthConfig} from './oidc';
import {tokenLifetime,type Session} from './model';
import {saveSession} from './storage';
import {loginError} from './errors';

export type LoginState={kind:'idle'}|{kind:'pending';message:string}|{kind:'error';message:string};

export function useLogin(currentId:string|undefined,restoreCopy:(id:string)=>void,notify:(message:string)=>void){
  const [open,setOpen]=useState(false);
  const [username,setUsername]=useState('reader');
  const [state,setState]=useState<LoginState>({kind:'idle'});
  const [config,setConfig]=useState<AuthConfig>();
  const [configLoading,setConfigLoading]=useState(true);
  const [configError,setConfigError]=useState('');
  const pending=useRef(false),configPending=useRef(false),callbackStarted=useRef(false);
  const development=Boolean(config?.dev_auth);
  const reloadConfig=useCallback(async(force=false)=>{
    if(configPending.current)return;
    configPending.current=true;setConfigLoading(true);setConfigError('');
    if(force&&!pending.current)setState({kind:'idle'});
    try{
      await requireHostAccess([API_ORIGIN]);
      setConfig(await new Api(API_BASE).authConfig(force));
    }
    catch(error){setConfig(undefined);setConfigError(`GET /v1/auth/config · ${loginError(error)}`);}
    finally{configPending.current=false;setConfigLoading(false);}
  },[]);
  useEffect(()=>{void reloadConfig();},[reloadConfig]);
  useEffect(()=>{
    if(callbackStarted.current||!isOidcCallback())return;
    callbackStarted.current=true;pending.current=true;setOpen(true);
    setState({kind:'pending',message:msg("正在确认登录结果")});
    const entryId=sessionStorage.getItem('nc-login-copy');
    if(entryId)restoreCopy(entryId);
    sessionStorage.removeItem('nc-login-copy');
    void finishOidc().then(async value=>{
      if(!value)throw Error(msg("未收到登录结果，请重新登录。"));
      if(value.apiOrigin!==API_ORIGIN)throw Error(msg("登录期间服务地址已切换，请回到原服务或重新登录。"));
      await saveSession(value);
      setState({kind:'idle'});setOpen(false);notify(msg("登录成功，已返回原来的阅读位置"));
    }).catch(e=>setState({kind:'error',message:loginError(e)}))
      .finally(()=>{pending.current=false;});
  },[restoreCopy,notify]);

  async function authenticate(){
    if(pending.current)return;
    if(development&&!username.trim())return;
    pending.current=true;
    setState({kind:'pending',message:development?msg("正在连接你的账户"):msg("请在安全登录页面完成授权")});
    try{
      let value:Session;
      if(development){
        const issuedAt=Date.now(),result=await new Api(API_BASE).login(username.trim()).catch(error=>{throw Error(`POST /v1/auth/dev · ${loginError(error)}`);});
        value={id:crypto.randomUUID(),token:result.access_token,...tokenLifetime(result.expires_in,issuedAt),user:result.user,apiOrigin:API_ORIGIN,credential:{kind:'development'}};
      }else{
        if(!config)throw Error(msg("无法读取身份服务配置，请重试。"));
        if(currentId)sessionStorage.setItem('nc-login-copy',currentId);
        else sessionStorage.removeItem('nc-login-copy');
        const result=await startOidc(config,API_BASE);
        // Web sign-in is leaving this page. Keep the waiting state until navigation.
        if(!result)return;
        value=result;
      }
      if(value.apiOrigin!==API_ORIGIN)throw Error(msg("登录期间服务地址已切换，请重新登录。"));
      setState({kind:'pending',message:msg("正在连接你的账户")});
      await saveSession(value);sessionStorage.removeItem('nc-login-copy');
      setState({kind:'idle'});setOpen(false);notify(msg("已连接账户，可以开始翻译了"));
    }catch(e){setState({kind:'error',message:loginError(e)});}
    finally{pending.current=false;}
  }
  return {open,setOpen,username,setUsername,state,config,configLoading,configError,development,reloadConfig,authenticate};
}
