import {defineContentScript} from 'wxt/utils/define-content-script';
import {installDriveBridge} from '../src/comics/sources/google-drive/bridge-content';
export default defineContentScript({registration: 'runtime', main() { void installDriveBridge(); }});
