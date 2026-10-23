import {verifySerialSite} from '../../../shared/gigaviewer/tests/serial-contract';
import {definition} from '../definition';
import {network} from '../network';
import {protocol} from '../protocol';

verifySerialSite(definition, protocol, network, 'https://cdn-ak-img.shonenjumpplus.com',
  'media:jump_plus:search_result_include_episode_volume_and_magazine', true);
