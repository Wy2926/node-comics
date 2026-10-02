import {commandById,shortcutCommands,type ShortcutId,type ShortcutOverrides,type ShortcutScope} from './catalog';
import {validateBinding} from './keys';

export function resolveBindings(id:ShortcutId,overrides:ShortcutOverrides):readonly string[] {
  return overrides[id]??commandById.get(id)!.defaults;
}
export function scopesOverlap(a:ShortcutScope,b:ShortcutScope):boolean {
  return a===b||a==='global'&&b!=='web'||b==='global'&&a!=='web';
}
export function findConflict(id:ShortcutId,binding:string,overrides:ShortcutOverrides):ShortcutId|undefined {
  const scope=commandById.get(id)!.scope;
  return shortcutCommands.find(command=>command.id!==id&&scopesOverlap(scope,command.scope)&&resolveBindings(command.id,overrides).includes(binding))?.id;
}
/** Unknown IDs/invalid bindings never enter dispatch; [] is an intentional disable. */
export function normalizeOverrides(value:unknown):ShortcutOverrides {
  if(!value||typeof value!=='object'||Array.isArray(value))return {};
  const result:ShortcutOverrides={};
  for(const command of shortcutCommands){
    const raw=(value as Record<string,unknown>)[command.id];
    if(!Array.isArray(raw)||raw.length>2||!raw.every(item=>typeof item==='string'&&!validateBinding(item)))continue;
    const bindings=[...new Set(raw)] as string[];
    if(JSON.stringify(bindings)!==JSON.stringify(command.defaults))result[command.id]=bindings;
  }
  return result;
}

/** Stored or concurrent conflicts fail closed, including both sides of a conflict. */
export function activeBindings(overrides:ShortcutOverrides):Map<string,ShortcutId[]> {
  const bindings=new Map<string,ShortcutId[]>();
  for(const command of shortcutCommands)for(const binding of resolveBindings(command.id,overrides)){
    if(findConflict(command.id,binding,overrides))continue;
    const ids=bindings.get(binding)??[];ids.push(command.id);bindings.set(binding,ids);
  }
  return bindings;
}
