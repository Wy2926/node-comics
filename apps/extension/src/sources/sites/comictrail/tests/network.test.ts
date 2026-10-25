import {verifySerialSite} from '../../../shared/gigaviewer/tests/serial-contract';
import {definition} from '../definition';
import {network} from '../network';
import {protocol} from '../protocol';

verifySerialSite(definition, protocol, network, 'https://cdn-img.comic-trail.com',
  'common:search_result', false, '2026-10-25');
