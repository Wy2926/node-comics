import {gigaViewerAssetUrls, gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';

export const urls = gigaViewerAssetUrls('https://cdn-img.magcomi.com');
export const protocol = gigaViewerSerialProtocol(identity, urls);
