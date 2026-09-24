import {verifyInlineImages} from '../../../../../../../scripts/inline_site_helpers.mjs';
export const verifyInline = context => verifyInlineImages(context, {
  id: 'mangacopy', route: 'https://mangacopy.com/**',
  url: 'https://mangacopy.com/comic/fixture/chapter/724f819b-5306-11ea-b7ea-024352452ce0', catalogUrl: 'https://mangacopy.com/comic/fixture',
  first: '#comic-0', lazy: '#comic-1',
  markup: data => `<div class="comicContent-list"><img id="comic-0" src="${data}"><img class="lazy" id="comic-1"></div>`,
});
