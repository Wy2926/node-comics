import {gigaViewerAssetUrls, gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';

export const urls = gigaViewerAssetUrls('https://cdn-img.comic-trail.com');
export const protocol = gigaViewerSerialProtocol(identity, urls);
