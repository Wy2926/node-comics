import type {CreateSourcePage} from '../../contracts/page';
import {comiciPage} from '../../shared/comici/page';
import {hanayumeLocation} from './definition';

export const createPage: CreateSourcePage = context => comiciPage(context, hanayumeLocation);
