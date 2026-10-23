import {gigaViewerSerialNetwork} from '../../shared/gigaviewer/serial-network';
import {protocol} from './protocol';
import {search} from './search';

const serial = gigaViewerSerialNetwork(protocol);
export const network = {...serial.network, search};
export const {parseEntries} = serial;
export {parseInfo} from '../../shared/gigaviewer/serial-network';
