import {defineContentScript} from 'wxt/utils/define-content-script';
import {installWebShortcuts} from '../src/shortcuts/web-content';
import {installImageSelection} from '../src/inline/selection';

export default defineContentScript({matches:['http://*/*','https://*/*'],runAt:'document_idle',allFrames:false,main(ctx){
  ctx.onInvalidated(installWebShortcuts());
  ctx.onInvalidated(installImageSelection(document));
}});
