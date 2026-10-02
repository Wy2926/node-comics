import {DOMParser as XmlDomParser} from '@xmldom/xmldom';

/** Node tests only. Reject all parser warnings/errors; native Chromium is tested separately. */
export function installTestXmlParser(){
  class StrictXmlParser extends XmlDomParser {
    constructor(){super({onError(){throw new Error('Invalid test XML');}});}
  }
  Object.defineProperty(globalThis,'DOMParser',{value:StrictXmlParser,writable:true,configurable:true});
}
