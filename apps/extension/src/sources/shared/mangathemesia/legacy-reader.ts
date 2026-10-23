/** Read only the verified document-ready wrapper's direct literal call; never run its code. */
export function legacyReaderData(script: string): unknown | undefined {
  if (!/\bts_reader\s*\.\s*run\s*\(/.test(script)) return undefined;
  const wrapper = /^jQuery\s*\(\s*document\s*\)\s*\.\s*ready\s*\(\s*function\s*\(\s*\$\s*\)\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/.exec(script);
  if (!wrapper) return undefined;
  const body = wrapper[1], stack: string[] = [];
  let previous = ';', result: unknown, calls = 0;
  const invalid = () => {throw Error('MangaThemesia 旧版正文不是受支持的静态 JSON。');};
  function quoted(start: number) {
    const quote = body[start];
    for (let i = start + 1; i < body.length; i++) {
      if (body[i] === '\\') {i++; continue;}
      if (body[i] === quote) return i + 1;
    }
    return invalid();
  }
  for (let i = 0; i < body.length;) {
    const char = body[i];
    if (/\s/.test(char)) {i++; continue;}
    if (body.startsWith('//', i)) {const end = body.indexOf('\n', i + 2); i = end < 0 ? body.length : end + 1; continue;}
    if (body.startsWith('/*', i)) {const end = body.indexOf('*/', i + 2); if (end < 0) invalid(); i = end + 2; continue;}
    // Attribute templates are inert too. Nested template syntax/regex literals are not this variant.
    if (char === '"' || char === "'" || char === '`') {i = quoted(i); previous = 'value'; continue;}
    if (char === '/') invalid();
    if (/[A-Za-z_$]/.test(char)) {
      const start = i++;
      while (i < body.length && /[\w$]/.test(body[i])) i++;
      const word = body.slice(start, i);
      if (word !== 'ts_reader') {previous = word; continue;}
      if (stack.length || previous !== ';' || ++calls !== 1) invalid();
      const call = /^\s*\.\s*run\s*\(\s*/.exec(body.slice(i));
      if (!call) invalid();
      i += call![0].length;
      const jsonStart = i;
      if (body[i] !== '{') invalid();
      let depth = 0;
      do {
        if (body[i] === '"') {i = quoted(i); continue;}
        if (body[i] === '{') depth++;
        if (body[i++] === '}') depth--;
      } while (depth && i < body.length);
      if (depth) invalid();
      try {result = JSON.parse(body.slice(jsonStart, i));} catch {invalid();}
      const end = /^\s*\)\s*;/.exec(body.slice(i));
      if (!end) invalid();
      i += end![0].length; previous = ';'; continue;
    }
    if ('({['.includes(char)) stack.push(char);
    if (')}]'.includes(char) && stack.pop() !== ({')': '(', '}': '{', ']': '['} as Record<string, string>)[char]) invalid();
    previous = char; i++;
  }
  if (stack.length || calls !== 1) invalid();
  return result;
}
