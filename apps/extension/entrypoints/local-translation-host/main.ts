import {registerLocalHost} from '../../src/translation/channels/local-host';
import {LOCAL_HOST_MESSAGE} from '../../src/translation/channels/host-client';
registerLocalHost(async()=>{await chrome.runtime.sendMessage({type:LOCAL_HOST_MESSAGE,action:'close'});});
