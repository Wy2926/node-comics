import { defineContentScript } from 'wxt/utils/define-content-script';
import { installSourceContent } from '../src/sources/runtime/content';
export default defineContentScript({registration:'runtime',main:installSourceContent});
