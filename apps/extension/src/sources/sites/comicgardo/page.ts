import type {CreateSourcePage} from '../../contracts/page';
import {gigaViewerPage} from '../../shared/gigaviewer/page';
import {protocol} from './protocol';

export const createPage: CreateSourcePage = context => gigaViewerPage(context, protocol.parsePages);
