import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'takecomic', origin: 'https://takecomic.jp', queries: ["手紙の魔女","信長の嫁"]});
