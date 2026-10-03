import type {CreateSourcePage} from '../../contracts/page';
import {gigaViewerPage} from '../../shared/gigaviewer/page';
import {parsePages} from './pages';

export const createPage: CreateSourcePage = context => gigaViewerPage(context, parsePages);
