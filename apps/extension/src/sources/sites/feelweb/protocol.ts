import {gigaViewerAssetUrls, gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';

export const urls = gigaViewerAssetUrls('https://cdn-img.feelweb.jp');
export const protocol = gigaViewerSerialProtocol(identity, urls);
