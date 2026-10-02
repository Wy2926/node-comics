import {invalidCatalog,OpdsError} from './errors';
import {msg} from '../../../i18n/runtime';
import {attribute,children,childText,parseXml,type XmlNode} from './xml';

export const PSE_REL='http://vaemendis.net/opds-pse/stream';
const ATOM='http://www.w3.org/2005/Atom',OPDS='http://opds-spec.org/2010/catalog',PSE='http://vaemendis.net/opds-pse/ns';
export interface OpdsLink {href:string;type?:string;rels:string[];title?:string;templated?:boolean;count?:number;lastRead?:number;lastReadDate?:string;indirect:boolean;encrypted?:boolean;facetGroup?:string;active?:boolean;width?:number;height?:number;}
export interface OpdsPublication {identity?:string;title:string;authors:string[];summary?:string;modified?:string;links:OpdsLink[];images:OpdsLink[];readingOrder?:OpdsLink[];}
export interface OpdsSection {title:string;links:OpdsLink[];navigation:OpdsLink[];publications:OpdsPublication[];}
export interface OpdsCatalog extends OpdsSection {protocol:'opds1'|'opds2';facets:{title:string;links:OpdsLink[]}[];groups:OpdsSection[];}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const string=(v:unknown)=>typeof v==='string'?v:undefined;
const localized=(v:unknown):string=>string(v)??Object.values(object(v)).find(x=>typeof x==='string') as string??'';
const integer=(v:unknown)=>Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):undefined;
export const mediaType=(v?:string)=>v?.split(';')[0].trim().toLowerCase()??'';
export const hasRel=(link:OpdsLink,rel:string)=>link.rels.includes(rel);
export const isAcquisition=(link:OpdsLink)=>link.rels.some(rel=>['acquisition','download','http://opds-spec.org/acquisition','http://opds-spec.org/acquisition/open-access'].includes(rel));
export const isManifest=(link:OpdsLink)=>['application/divina+json','application/webpub+json'].includes(mediaType(link.type));
export const isBitmap=(link:OpdsLink)=>!link.encrypted&&['image/jpeg','image/png','image/webp','image/gif','image/avif','image/bmp'].includes(mediaType(link.type));
export function absoluteHref(href:string,base:string):string {try{return new URL(href,base).href.replace(/%7B/gi,'{').replace(/%7D/gi,'}');}catch{throw invalidCatalog();}}
function jsonLink(value:unknown,base:string):OpdsLink|undefined {
  const link=object(value);if(typeof link.href!=='string')return;
  const properties=object(link.properties),rel=link.rel;
  return {href:absoluteHref(link.href,base),type:string(link.type),rels:typeof rel==='string'?[rel]:array(rel).filter((x):x is string=>typeof x==='string'),title:localized(link.title)||undefined,templated:link.templated===true,indirect:array(properties.indirectAcquisition).length>0,encrypted:!!properties.encrypted,width:integer(link.width),height:integer(link.height)};
}
const jsonLinks=(value:unknown,base:string)=>array(value).map(v=>jsonLink(v,base)).filter((v):v is OpdsLink=>!!v);
export function jsonPublication(value:unknown,base:string):OpdsPublication {
  const pub=object(value),meta=object(pub.metadata),title=localized(meta.title);if(!title)throw invalidCatalog();
  const links=jsonLinks(pub.links,base),self=links.find(l=>hasRel(l,'self'));
  // metadata.identifier is an ISBN/work identifier, never the catalog-record key.
  const authors=Array.isArray(meta.author)?meta.author:meta.author?[meta.author]:[];
  const readingOrder=Array.isArray(pub.readingOrder)?jsonLinks(pub.readingOrder,base):undefined;
  if(readingOrder&&readingOrder.length!==(pub.readingOrder as unknown[]).length)throw invalidCatalog();
  return {identity:self?.href,title,authors:authors.map(a=>typeof a==='string'?a:localized(object(a).name)).filter(Boolean),summary:string(meta.description),modified:string(meta.modified),links,images:jsonLinks(pub.images,base),...(readingOrder?{readingOrder}:{})};
}
function jsonSection(value:unknown,base:string):OpdsSection {
  const v=object(value);return {title:localized(object(v.metadata).title)||'OPDS',links:jsonLinks(v.links,base),navigation:jsonLinks(v.navigation,base),publications:array(v.publications).map(p=>jsonPublication(p,base))};
}
function xmlLink(node:XmlNode):OpdsLink|undefined {
  const href=attribute(node,'href');if(!href)return;
  const rel=attribute(node,'rel')??'alternate';
  return {href:absoluteHref(href,node.base),type:attribute(node,'type'),rels:rel.split(/\s+/),title:attribute(node,'title'),indirect:children(node,'indirectAcquisition',OPDS).length>0,count:integer(attribute(node,'count',PSE)),lastRead:integer(attribute(node,'lastRead',PSE)),lastReadDate:attribute(node,'lastReadDate',PSE),facetGroup:attribute(node,'facetGroup',OPDS),active:attribute(node,'activeFacet',OPDS)==='true'};
}
const xmlLinks=(node:XmlNode)=>children(node,'link',ATOM).map(xmlLink).filter((v):v is OpdsLink=>!!v);
function xmlPublication(node:XmlNode):OpdsPublication {
  const links=xmlLinks(node),title=childText(node,'title',ATOM);if(!title)throw invalidCatalog();
  return {identity:childText(node,'id',ATOM)||links.find(l=>hasRel(l,'self'))?.href,title,authors:children(node,'author',ATOM).map(a=>childText(a,'name',ATOM)).filter(Boolean),summary:childText(node,'summary',ATOM)||childText(node,'content',ATOM)||undefined,modified:childText(node,'updated',ATOM)||undefined,links,images:links.filter(l=>l.rels.some(r=>r==='http://opds-spec.org/image'||r==='http://opds-spec.org/image/thumbnail'))};
}
function authDocument(value:unknown):never {
  const auth=array(object(value).authentication);
  if(auth.some(a=>object(a).type==='http://opds-spec.org/auth/basic'))throw new OpdsError('authentication-required','此 OPDS 服务需要 Basic 用户名和密码，请编辑连接授权。');
  throw new OpdsError('unsupported-auth','此 OPDS 服务要求尚未支持的登录流程；目前支持匿名、Basic 和令牌地址。');
}
export function parseCatalog(text:string,url:string,contentType=''):OpdsCatalog {
  if(text.length>4*1024*1024)throw invalidCatalog();
  if(text.trimStart().startsWith('{')) {
    let value:unknown;try{value=JSON.parse(text);}catch{throw invalidCatalog();}
    const v=object(value);if(mediaType(contentType)==='application/opds-authentication+json'||v.authentication)authDocument(v);
    if(!('navigation' in v||'publications' in v||'groups' in v))throw invalidCatalog();
    return {...jsonSection(v,url),protocol:'opds2',groups:array(v.groups).map(g=>jsonSection(g,url)),facets:array(v.facets).map(f=>({title:localized(object(object(f).metadata).title)||msg('筛选'),links:jsonLinks(object(f).links,url)}))};
  }
  const root=parseXml(text,url);if(root.name!=='feed'||root.ns!==ATOM)throw invalidCatalog();
  const links=xmlLinks(root),navigation:OpdsLink[]=[],publications:OpdsPublication[]=[],facetMap=new Map<string,OpdsLink[]>();
  for(const entry of children(root,'entry',ATOM)) {
    const pub=xmlPublication(entry),detail=pub.links.find(l=>hasRel(l,'alternate')&&mediaType(l.type)==='application/atom+xml'&&l.type?.includes('type=entry'));
    if(pub.links.some(l=>isAcquisition(l)||hasRel(l,PSE_REL))||detail)publications.push(pub);
    else for(const link of pub.links.filter(l=>['application/atom+xml','application/opds+json'].includes(mediaType(l.type))))navigation.push({...link,title:pub.title});
  }
  for(const link of links.filter(l=>hasRel(l,'http://opds-spec.org/facet'))){const title=link.facetGroup??msg('筛选');const items=facetMap.get(title)??[];items.push(link);facetMap.set(title,items);}
  return {protocol:'opds1',title:childText(root,'title',ATOM)||'OPDS',links,navigation,publications,groups:[],facets:[...facetMap].map(([title,links])=>({title,links}))};
}
export function parsePublication(text:string,url:string):OpdsPublication {
  if(text.trimStart().startsWith('{')){try{return jsonPublication(JSON.parse(text),url);}catch(e){if(e instanceof OpdsError)throw e;throw invalidCatalog();}}
  const root=parseXml(text,url);if(root.ns!==ATOM||root.name!=='entry')throw invalidCatalog();return xmlPublication(root);
}
export function parseSearchDescription(text:string,url:string):string {
  const root=parseXml(text,url),link=root.children.find(n=>n.name==='Url'&&['application/atom+xml','application/opds+json'].includes(mediaType(attribute(n,'type'))));
  if(!link||!attribute(link,'template'))throw new OpdsError('unsupported','此目录搜索模板暂不支持。');return absoluteHref(attribute(link,'template')!,link.base);
}
/** RFC6570 query expansion subset used by OPDS2 and OpenSearch; never eval templates. */
export function expandSearch(template:string,query:string):string {
  let replaced=false;
  const result=template.replace(/\{([?&]?)([^{}]+)\}/g,(_all,operator:string,vars:string)=>{
    const values=vars.split(',').flatMap(variable=>{const name=variable.replace(/\?$/,'');if(['query','searchTerms'].includes(name)){replaced=true;return [operator?`${name}=${encodeURIComponent(query)}`:encodeURIComponent(query)];}if(variable.endsWith('?'))return [];throw new OpdsError('unsupported','此目录搜索需要尚未支持的参数。');});
    return values.length?`${operator}${values.join('&')}`:'';
  });
  if(!replaced||/[{}]/.test(result))throw new OpdsError('unsupported','此目录搜索模板暂不支持。');return result;
}
export function safePse(link:OpdsLink):boolean {
  // Kavita v0.9.1.4 GET image mutates progress even with saveProgress=false for most clients.
  // Do not spoof another reader's user-agent or probe this endpoint to determine its behavior.
  return hasRel(link,PSE_REL)&&isBitmap(link)&&!!link.count&&link.count<=20000&&link.href.includes('{pageNumber}')&&!/\/api\/opds\/[^/]+\/image(?:[/?]|$)/i.test(new URL(link.href).pathname+'?');
}
