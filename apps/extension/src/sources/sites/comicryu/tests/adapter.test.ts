import {verifyComiciAdapter} from '../../../shared/comici/tests/adapter-contract';
import {definition} from '../definition';
import {protocol} from '../protocol';
import {network} from '../network';
import {createPage} from '../page';
import {image} from '../image';

verifyComiciAdapter({definition, protocol, network, createPage, image, imageOrigin: 'https://viewer.comic-ryu.jp'});
