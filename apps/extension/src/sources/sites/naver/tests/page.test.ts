import {verifyImageSelection} from '../../../../../tests/site-inline-selection';
verifyImageSelection({url: 'https://comic.naver.com/webtoon/detail?titleId=123&no=1', catalogUrl: 'https://comic.naver.com/webtoon/list?titleId=123',
  selector: '.wt_viewer > img[id^="content_image_"]', ids: ['content_image_0', 'content_image_1']});
