import { defineContentScript } from 'wxt/utils/define-content-script';
import { sourceInstallation } from '../src/sources';
import { installSourceContent } from '../src/sources/runtime/content';
export default defineContentScript({matches:sourceInstallation.autoContentMatches,runAt:'document_idle',main:installSourceContent});
