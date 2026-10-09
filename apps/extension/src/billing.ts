import type {UiLocale} from './i18n/locales';
import {getLocale} from './i18n/runtime';

export function pricingUrl(locale:UiLocale){
  const prefix=locale==='zh-CN'?'':`/${locale.toLowerCase()}`;
  return `https://comics.nodelane.net${prefix}/pricing/`;
}

export function openPricing(){
  window.open(pricingUrl(getLocale()),'_blank','noopener,noreferrer');
}
