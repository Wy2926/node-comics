import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'championcross', origin: 'https://championcross.jp', queries: ["入間","弱虫ペダル"]});
