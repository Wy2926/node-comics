import {defineContentScript} from 'wxt/utils/define-content-script';
import {connectContentLocale} from '../src/i18n/content';
import {installImmersive} from '../src/immersive/content';

export default defineContentScript({registration:'runtime',main(){
  const state=globalThis as typeof globalThis&{__ncImmersive?:boolean};
  if(state.__ncImmersive)return;state.__ncImmersive=true;connectContentLocale();installImmersive();
}});
