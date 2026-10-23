import {gigaViewerSerialNetwork} from '../../shared/gigaviewer/serial-network';
import {gigaViewerSerialSearch} from '../../shared/gigaviewer/serial-search';
import {protocol} from './protocol';

export const network = {...gigaViewerSerialNetwork(protocol).network,
  ...gigaViewerSerialSearch(protocol, 'media:jump_plus:search_result_include_episode_volume_and_magazine', true)};
