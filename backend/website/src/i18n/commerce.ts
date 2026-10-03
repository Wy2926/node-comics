import {commerce as fr} from './extra/fr';
import {commerce as es} from './extra/es';
import {commerce as ptBR} from './extra/pt-BR';
import {commerce as de} from './extra/de';
import {commerce as it} from './extra/it';
import {commerce as ru} from './extra/ru';
import {commerce as pl} from './extra/pl';
import {commerce as uk} from './extra/uk';
import {commerce as tr} from './extra/tr';
import {commerce as vi} from './extra/vi';
import {commerce as id} from './extra/id';
const copies = {'fr':fr,'es':es,'pt-BR':ptBR,'de':de,'it':it,'ru':ru,'pl':pl,'uk':uk,'tr':tr,'vi':vi,'id':id};
export const commerceCopy = (locale:string) => copies[locale as keyof typeof copies];
export function formatCopy(template:string,values:Record<string,string|number>) {
  return template.replace(/\{(\w+)\}/g,(token,key)=>String(values[key]??token));
}
