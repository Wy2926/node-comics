import { invalidCatalog } from './errors';

export interface XmlNode {
  name: string;
  ns: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
  base: string;
}
const XML = 'http://www.w3.org/XML/1998/namespace';
/** Native XML owns namespaces/entities/well-formedness. Never insert nodes into the page. */
export function parseXml(source: string, base: string): XmlNode {
  if (source.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw invalidCatalog();
  let document: Document;
  try {
    document = new DOMParser().parseFromString(source, 'application/xml');
  } catch {
    throw invalidCatalog();
  }
  if (!document.documentElement || document.getElementsByTagName('parsererror').length)
    throw invalidCatalog();
  let count = 0;
  function node(element: Element, parentBase: string, depth: number): XmlNode {
    if (++count > 100000 || depth > 64) throw invalidCatalog();
    let nodeBase = parentBase;
    const xmlBase = element.getAttributeNS(XML, 'base');
    try {
      if (xmlBase) nodeBase = new URL(xmlBase, parentBase).href;
    } catch {
      throw invalidCatalog();
    }
    const attributes: Record<string, string> = {};
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes.item(i)!;
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      attributes[attr.namespaceURI ? `{${attr.namespaceURI}}${attr.localName}` : attr.name] =
        attr.value;
    }
    const children: XmlNode[] = [];
    let text = '';
    for (let i = 0; i < element.childNodes.length; i++) {
      const child = element.childNodes.item(i)!;
      if (child.nodeType === 1) children.push(node(child as Element, nodeBase, depth + 1));
      else if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue ?? '';
    }
    return {
      name: element.localName,
      ns: element.namespaceURI ?? '',
      attributes,
      children,
      text,
      base: nodeBase,
    };
  }
  return node(document.documentElement, base, 0);
}
export const children = (node: XmlNode, name: string, ns = node.ns) =>
  node.children.filter((child) => child.name === name && child.ns === ns);
export const childText = (node: XmlNode, name: string, ns = node.ns) =>
  children(node, name, ns)[0]?.text.trim() ?? '';
export const attribute = (node: XmlNode, name: string, ns?: string) =>
  node.attributes[ns ? `{${ns}}${name}` : name];
