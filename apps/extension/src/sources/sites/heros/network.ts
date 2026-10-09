import {comiciNetwork} from '../../shared/comici/network';
import {protocol} from './protocol';

export const {network, search, searchUrl, parseSearch, parseCatalogPage, parseReader, parseContents} = comiciNetwork(protocol);
