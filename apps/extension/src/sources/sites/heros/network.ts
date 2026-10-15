import {comiciNetwork} from '../../shared/comici/network';
import {protocol} from './protocol';

export const {network, search, searchUrl, parseSearch, parseCatalogPage, parseEpisode, parseContents} = comiciNetwork(protocol);
