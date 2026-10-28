// The only composition root allowed to import concrete channel implementations.
import {definition as nodelane} from './adapters/nodelane/definition';
import {definition as mangaTranslator} from './adapters/manga-translator-ui/definition';
import {definition as shinobu} from './adapters/shinobu/definition';
import type {ChannelDefinition} from './contracts';

const definitions:readonly ChannelDefinition[]=[nodelane,mangaTranslator,shinobu];
export const channelDefinitions=()=>definitions;
export function channelDefinition(id:string):ChannelDefinition {
  const definition=definitions.find(item=>item.id===id);
  if(!definition)throw new Error('Unknown translation channel protocol');
  return definition;
}
