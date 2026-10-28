import {registerLocalHost} from '../../src/translation/channels/local-host';
import {msg} from '../../src/i18n/runtime';
const status=document.getElementById('status')!;
status.textContent=msg('等待翻译');
void navigator.locks.request('nc-local-host-singleton',async()=>{
  const stop=registerLocalHost(busy=>{status.textContent=busy?msg('翻译中'):msg('等待翻译');});
  const button=document.createElement('button');button.textContent=msg('停止');button.onclick=()=>void stop();document.body.append(button);
  await new Promise(()=>{});
});
