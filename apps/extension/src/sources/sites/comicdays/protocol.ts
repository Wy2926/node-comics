import {gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';
import {urls} from './urls';

export const protocol = gigaViewerSerialProtocol(identity, urls);
export const {parseReader, coverUrl} = protocol;
