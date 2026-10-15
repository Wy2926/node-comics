import {comiciNetwork} from '../../shared/comici/network';
import {protocol} from './protocol';

export const {network, searchUrl, parseSearch, parseCatalogPage, parseEpisode, parseContents} = comiciNetwork(protocol);
