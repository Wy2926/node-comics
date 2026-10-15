import {verifyComiciHttp} from '../../../shared/comici/tests/verify-http.mjs';
await verifyComiciHttp({id: 'comicpash', origin: 'https://comicpash.jp', queries: ['くま', '地味な剣聖']});
