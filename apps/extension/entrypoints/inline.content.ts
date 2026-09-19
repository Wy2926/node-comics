import {defineContentScript} from 'wxt/utils/define-content-script';
import {installInline} from '../src/inline/content';

export default defineContentScript({registration:'runtime',main(){
  const state=globalThis as typeof globalThis & {__ncInline?:boolean};
  if(state.__ncInline)return;state.__ncInline=true;installInline();
}});
