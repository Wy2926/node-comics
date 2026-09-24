import {verifyInlineImages} from '../../../../../../../scripts/inline_site_helpers.mjs';
export const verifyInline = context => verifyInlineImages(context, {
  id: 'naver', route: 'https://comic.naver.com/**',
  url: 'https://comic.naver.com/webtoon/detail?titleId=123&no=1', catalogUrl: 'https://comic.naver.com/webtoon/list?titleId=123',
  first: '#content_image_0', lazy: '#content_image_1',
  markup: data => `<div class="wt_viewer"><img id="content_image_0" src="${data}"><img class="lazy" id="content_image_1"><img id="age-notice" src="${data}"></div>`,
});
