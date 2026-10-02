const modifiers = ['Ctrl','Alt','Shift','Meta'] as const;
const codes = /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Left|Right|Up|Down)|PageUp|PageDown|Home|End|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|NumpadAdd|NumpadSubtract|NumpadMultiply|NumpadDivide|NumpadDecimal|NumpadEnter)$/;

export function validateBinding(binding:string):'reserved'|'invalid'|undefined {
  if(typeof binding!=='string'||binding.length>64)return 'invalid';
  const parts=binding.split('+'),code=parts.pop()!;
  if(!codes.test(code)||parts.some(part=>!modifiers.includes(part as typeof modifiers[number]))||new Set(parts).size!==parts.length||parts.join('+')!==modifiers.filter(modifier=>parts.includes(modifier)).join('+'))return 'invalid';
  const ctrl=parts.includes('Ctrl'),meta=parts.includes('Meta'),alt=parts.includes('Alt'),shift=parts.includes('Shift');
  // Keep browser navigation, editing, accessibility and dialog cancellation native.
  if(['Escape','Tab','F1','F3','F5','F6','F11','F12'].includes(code)||!parts.length&&['Enter','NumpadEnter','Backspace','Delete','Insert'].includes(code))return 'reserved';
  if(alt&&!ctrl&&!meta&&['ArrowLeft','ArrowRight','Home','F4','Space','KeyD','KeyE','KeyF'].includes(code)||shift&&code==='F10')return 'reserved';
  if((ctrl||meta)&&!alt&&(/^(?:Key[ACDEFGHJKLNOPQRSTUVWXYZ]|Digit[0-9]|Equal|Minus|NumpadAdd|NumpadSubtract|PageUp|PageDown|Space|F4|Delete)$/.test(code)||shift&&/^Key[BIM]$/.test(code)))return 'reserved';
}

export function bindingFromEvent(event:KeyboardEvent):string|undefined {
  if(event.isComposing||event.keyCode===229||event.key==='Dead'||event.key==='Process'||event.getModifierState?.('AltGraph'))return;
  if(!codes.test(event.code))return;
  return [event.ctrlKey&&'Ctrl',event.altKey&&'Alt',event.shiftKey&&'Shift',event.metaKey&&'Meta',event.code].filter(Boolean).join('+');
}

const keyLabels:Record<string,string>={ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',PageUp:'Page Up',PageDown:'Page Down',Space:'Space',Minus:'−',Equal:'=',BracketLeft:'[',BracketRight:']',Backslash:'\\',Semicolon:';',Quote:"'",Backquote:'`',Comma:',',Period:'.',Slash:'/',Meta:'⌘',NumpadAdd:'Num +',NumpadSubtract:'Num −',NumpadMultiply:'Num ×',NumpadDivide:'Num /',NumpadDecimal:'Num .',NumpadEnter:'Num Enter'};
export function formatBinding(binding:string):string {
  return binding.split('+').map(part=>keyLabels[part]??part.replace(/^Key|^Digit/,'').replace(/^Numpad/,'Num ')).join(' + ');
}
