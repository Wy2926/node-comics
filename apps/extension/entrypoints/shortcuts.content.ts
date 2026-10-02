import {defineContentScript} from 'wxt/utils/define-content-script';
import {installWebShortcuts} from '../src/shortcuts/web-content';

export default defineContentScript({matches:['http://*/*','https://*/*'],runAt:'document_idle',allFrames:false,main(ctx){
  ctx.onInvalidated(installWebShortcuts());
}});
