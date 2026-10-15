import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'asacomi', origin: 'https://asacomi.jp', queries: ['御成敗式目', '半径45センチ']});
