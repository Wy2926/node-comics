import {defineContentScript} from 'wxt/utils/define-content-script';
import {connectContentLocale} from '../src/i18n/content';
import {installRegion} from '../src/region/content';

export default defineContentScript({registration:'runtime',main(){
  const state=globalThis as typeof globalThis&{__ncRegion?:boolean};
  if(state.__ncRegion)return;state.__ncRegion=true;connectContentLocale();installRegion();
}});
