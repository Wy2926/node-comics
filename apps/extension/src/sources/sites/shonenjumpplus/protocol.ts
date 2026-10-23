import {gigaViewerAssetUrls, gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';

export const urls = gigaViewerAssetUrls('https://cdn-ak-img.shonenjumpplus.com');
export const protocol = gigaViewerSerialProtocol(identity, urls);
