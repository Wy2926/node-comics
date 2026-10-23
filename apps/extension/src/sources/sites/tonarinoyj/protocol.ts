import {gigaViewerAssetUrls, gigaViewerSerialProtocol} from '../../shared/gigaviewer/serial-protocol';
import {identity} from './definition';

export const urls = gigaViewerAssetUrls('https://cdn-img.tonarinoyj.jp');
export const protocol = gigaViewerSerialProtocol(identity, urls);
