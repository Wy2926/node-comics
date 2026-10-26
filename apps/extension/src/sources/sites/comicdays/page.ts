import type {CreateSourcePage} from '../../contracts/page';
import {gigaViewerSerialPage} from '../../shared/gigaviewer/serial-page';
import {protocol} from './protocol';

export const createPage: CreateSourcePage = context => gigaViewerSerialPage(context, protocol);
