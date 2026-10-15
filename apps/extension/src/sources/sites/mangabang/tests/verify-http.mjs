import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'mangabang', origin: 'https://comics.manga-bang.com', queries: ["ウェルカムバック","斬り開く"]});
