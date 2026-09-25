import {msg} from '../../src/i18n/runtime';
import {initializeUiLanguage} from '../../src/i18n/load';
import {registerImageTransferHost} from '../../src/translation/channels/transport/host';
import './style.css';

const status = document.getElementById('status')!;
let active = false;
const update = (busy: boolean) => {
  active = busy;
  document.getElementById('notice')!.textContent = msg('此标签页承载本地翻译请求，完成后会自动关闭。请在翻译期间保持打开。');
  status.textContent = busy ? msg('翻译中') : msg('等待翻译');
};
update(false);
registerImageTransferHost(update);
void initializeUiLanguage().then(() => update(active));
