import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const root=process.argv.find((arg,index)=>index>1&&!arg.startsWith('--'))??fileURLToPath(new URL('../',import.meta.url));
const relative=file=>path.relative(root,file).replaceAll('\\','/');
function files(directory){
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    return entry.isDirectory()?entry.name==='tests'?[]:files(file):/(?<!\.test)(?<!\.d)\.tsx?$/.test(entry.name)?[file]:[];
  });
}
const filenames=[...files(path.join(root,'src')),...files(path.join(root,'entrypoints'))];
const config=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
const {options}=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const program=ts.createProgram(filenames,options),checker=program.getTypeChecker();
// Build-time store metadata and the document title are not msg() calls.
const used=new Set(['store.name','store.description','brand.name']),errors=[],raw=[];
let calls=0;
function literals(type){
  if(type.isStringLiteral())return [type.value];
  if(type.isUnion()){
    const values=type.types.map(literals);
    return values.every(Boolean)?values.flat():undefined;
  }
}
function isMessageCall(node){
  if(!ts.isCallExpression(node))return false;
  let symbol=checker.getSymbolAtLocation(node.expression);
  if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  return symbol?.name==='msg'&&symbol.declarations?.some(declaration=>relative(declaration.getSourceFile().fileName)==='src/i18n/runtime.ts');
}
const parameters=[];
for(const filename of filenames){
  const source=program.getSourceFile(filename);
  const location=node=>`${relative(filename)}:${source.getLineAndCharacterOfPosition(node.getStart()).line+1}`;
  function visit(node){
    if(ts.isTypeNode(node))return;
    if(isMessageCall(node)){
      calls++;
      let argument=node.arguments[0];
      // A cast to MessageKey must not make the entire dictionary look used.
      while(argument&&(ts.isAsExpression(argument)||ts.isTypeAssertionExpression(argument)||ts.isParenthesizedExpression(argument)))argument=argument.expression;
      const keys=argument&&(ts.isStringLiteralLike(argument)?[argument.text]:literals(checker.getTypeAtLocation(argument)));
      if(!keys?.length)errors.push(`${location(node)}: message key is not a finite string literal union`);
      else{
        keys.forEach(key=>used.add(key));
        parameters.push({keys,location:location(node),names:node.arguments[1]?checker.getPropertiesOfType(checker.getTypeAtLocation(node.arguments[1])).map(property=>property.name):[]});
      }
      // Interpolated data can itself contain another msg() call.
      for(const argument of node.arguments.slice(1))visit(argument);
      return;
    }
    const text=ts.isStringLiteralLike(node)||ts.isJsxText(node)?node.text:ts.isTemplateExpression(node)?node.head.text+node.templateSpans.map(span=>span.literal.text).join(''):undefined;
    const parent=node.parent;
    const errorArgument=parent&&(ts.isCallExpression(parent)||ts.isNewExpression(parent))&&ts.isIdentifier(parent.expression)&&
      /^(?:Error|RangeError|TypeError|DOMException|DriveError)$/.test(parent.expression.text)&&parent.arguments?.[parent.expression.text==='DriveError'?1:0]===node;
    const uiAttribute=parent&&ts.isJsxAttribute(parent)&&/^(?:title|placeholder|alt|aria-label|label|description)$/.test(parent.name.getText(source));
    if(text&&(/[\u3400-\u9fff]/u.test(text)||(ts.isJsxText(node)||errorArgument||uiAttribute)&&/[a-zA-Z]{2}/.test(text))&&!relative(filename).startsWith('src/i18n/')){
      raw.push({location:location(node),kind:ts.isJsxText(node)?'jsx':ts.isTemplateExpression(node)?'template':'literal',text:ts.isTemplateExpression(node)?node.getText(source):text.trim()});
      if(filename.endsWith('.tsx')&&/[\u3400-\u9fff]/u.test(text))errors.push(`${location(node)}: hardcoded UI text: ${text.trim()}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
const directory=path.join(root,'src/i18n/dictionaries');
const dictionaries=Object.fromEntries(fs.readdirSync(directory).filter(file=>file.endsWith('.json')).map(file=>[file.slice(0,-5),JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'))]));
const tokens=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
const base=dictionaries['zh-CN'];
const unused=Object.keys(base).filter(key=>!used.has(key));
for(const [locale,dictionary] of Object.entries(dictionaries)){
  for(const key of used)if(!Object.hasOwn(dictionary,key))errors.push(`${locale}: missing ${key}`);
  for(const [key,value] of Object.entries(dictionary)){
    if(!used.has(key))errors.push(`${locale}: unused ${key}`);
    if(typeof value!=='string'||!value.trim())errors.push(`${locale}: empty/non-string ${key}`);
    else if(base[key]&&JSON.stringify(tokens(value))!==JSON.stringify(tokens(base[key])))errors.push(`${locale}: interpolation tokens differ for ${key}`);
  }
}
for(const {keys,location,names} of parameters){
  for(const key of keys){
    const expected=[...new Set(tokens(base[key]??key))];
    for(const name of expected)if(!names.includes(name))errors.push(`${location}: missing parameter {${name}} for ${key}`);
    for(const name of names)if(!expected.includes(name))errors.push(`${location}: unused parameter {${name}} for ${key}`);
  }
}
// Equal English text is an audit candidate, not an error: brands and some words
// are legitimately shared. A whole sentence still needs human language review.
const english=dictionaries.en??{};
const sameAsEnglish=Object.fromEntries(Object.entries(dictionaries).filter(([locale])=>locale!=='en'&&locale!=='zh-CN').map(([locale,dictionary])=>[locale,Object.keys(dictionary).filter(key=>dictionary[key]===english[key])]));
const result={modules:filenames.length,calls,locales:Object.keys(dictionaries).length,keys:Object.keys(base).length,used:[...used].sort(),unused,errors,raw,sameAsEnglish};
if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
else if(errors.length)console.error(errors.join('\n'));
else console.log(`Checked ${result.modules} modules, ${calls} msg() calls, ${used.size} keys and ${result.locales} dictionaries: no missing/unused keys or interpolation errors. Raw-text audit: ${raw.length} candidates (npm run audit:i18n).`);
if(errors.length)process.exitCode=1;
