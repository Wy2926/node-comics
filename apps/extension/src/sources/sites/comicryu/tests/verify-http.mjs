import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'comicryu', origin: 'https://comic-ryu.jp', queries: ["アリスと蔵六","ねこむすめ"]});
