import tokens from '../ui/theme/tokens.css?raw';

/** :root does not match in a shadow tree. Use an internal .theme element so the
 * source site's host styles cannot override the extension's semantic tokens. */
export function shadowThemeStyles(styles:string){
  return tokens.replaceAll(':root','.theme')+'\n'+styles;
}
