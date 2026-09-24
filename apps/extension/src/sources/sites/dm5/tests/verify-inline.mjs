import {verifyInlineImages} from '../../../../../../../scripts/inline_site_helpers.mjs';
export const verifyInline = context => verifyInlineImages(context, {
  id: 'dm5', route: 'https://www.dm5.com/**', url: 'https://www.dm5.com/m426475/', catalogUrl: 'https://www.dm5.com/manhua-yaoshenji/',
  first: '#cp_img #cp_image', lazy: '#showimage #cp_image',
  markup: data => `<div id="cp_img"><div class="item"><img id="cp_image" src="${data}"></div><div id="imgloading"><img src="${data}"></div></div><div id="showimage"><img class="lazy" id="cp_image"></div>`,
});
