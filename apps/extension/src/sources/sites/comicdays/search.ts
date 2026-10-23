import {gigaViewerSerialSearch} from '../../shared/gigaviewer/serial-search';
import {protocol} from './protocol';

export const {search, parseSearch} = gigaViewerSerialSearch(protocol, 'common:search_result');
