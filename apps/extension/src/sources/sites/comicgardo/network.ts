import {gigaViewerSerialNetwork} from '../../shared/gigaviewer/serial-network';
import {gigaViewerSerialSearch} from '../../shared/gigaviewer/serial-search';
import {protocol} from './protocol';

export const network = {...gigaViewerSerialNetwork(protocol).network,
  ...gigaViewerSerialSearch(protocol, {mediaName: 'gardo'}, true)};
