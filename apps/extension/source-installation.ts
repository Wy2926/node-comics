import {readdirSync, readFileSync} from 'node:fs';
import type {SourceDefinition} from './src/sources/contracts/definition';

// Build-time metadata only: never load a website's executable implementation in WXT config.
const root = new URL('./src/sources/sites/', import.meta.url);
const installations = readdirSync(root, {withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>{
  const value = JSON.parse(readFileSync(new URL(`${entry.name}/installation.json`,root),'utf8')) as SourceDefinition['installation'];
  for(const field of [value.requiredOrigins,value.autoContentMatches,value.optionalOrigins??[]]){
    if(!Array.isArray(field)||field.some(pattern=>typeof pattern!=='string'))throw Error('Invalid source installation metadata');
  }
  return value;
});
export const sourceInstallation = {
  requiredOrigins:[...new Set(installations.flatMap(value=>value.requiredOrigins))],
  autoContentMatches:[...new Set(installations.flatMap(value=>value.autoContentMatches))],
};
