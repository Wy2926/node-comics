import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';

const script=fileURLToPath(new URL('../scripts/check-i18n.mjs',import.meta.url));
let root:string;
const source=(name:string,text:string)=>{const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,text);};
const dictionary=(messages:Record<string,string>)=>source('src/i18n/dictionaries/zh-CN.json',JSON.stringify({'brand.name':'Brand','store.name':'Store','store.description':'Description',...messages}));
const run=()=>JSON.parse(spawnSync(process.execPath,[script,root,'--json'],{encoding:'utf8'}).stdout) as {used:string[];errors:string[];raw:{text:string}[]};
beforeEach(()=>{
  root=mkdtempSync(path.join(tmpdir(),'nc-i18n-check-'));
  source('tsconfig.json',JSON.stringify({compilerOptions:{strict:true}}));
  source('src/i18n/runtime.ts','export function msg(key:string,values?:Record<string,string|number>){return key;}');
  source('entrypoints/main.ts','export {};');
});
afterEach(()=>{
  if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('nc-i18n-check-'))throw Error('Unexpected fixture directory');
  rmSync(root,{recursive:true});
});
describe('dictionary usage audit',()=>{
  it('keeps dynamic literal unions, aliases, nested calls and metadata, but not test-only or plain strings',()=>{
    dictionary({'保存':'保存','索引':'索引','第 {0} 页':'第 {0} 页','测试专用':'测试专用','未接入':'未接入'});
    source('src/progress.ts',`import {msg as translate} from './i18n/runtime';
      export const progress=(label:'保存'|'索引')=>translate(label);
      translate('第 {0} 页',{'0':translate('保存')});const hardcoded='未接入';`);
    source('src/progress.test.ts',`import {msg} from './i18n/runtime';msg('测试专用');`);
    const result=run();
    expect(result.used).toEqual(expect.arrayContaining(['保存','索引','第 {0} 页','brand.name','store.name','store.description']));
    expect(result.errors).toEqual(['zh-CN: unused 测试专用','zh-CN: unused 未接入']);
    expect(result.raw.map(item=>item.text)).toContain('未接入');
  });
  it('reports missing dictionaries, interpolation mistakes and unsafe dynamic casts',()=>{
    dictionary({'你好 {name}':'你好 {name}'});
    source('entrypoints/main.ts',`import {msg} from '../src/i18n/runtime';
      msg('缺失');msg('你好 {name}',{wrong:'x'});
      export const unsafe=(key:string)=>msg(key as '你好 {name}');`);
    const errors=run().errors.join('\n');
    expect(errors).toContain('message key is not a finite string literal union');
    expect(errors).toContain('zh-CN: missing 缺失');
    expect(errors).toContain('missing parameter {name}');
    expect(errors).toContain('unused parameter {wrong}');
  });
  it('rejects hardcoded component text and only flags the literal parts of templates',()=>{
    dictionary({'译图':'译图'});
    source('src/Page.tsx',"import {msg} from './i18n/runtime';const alt=`page ${msg('译图')}`;const page=<p title='中文提示'>未翻译</p>;");
    const errors=run().errors;
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('hardcoded UI text: 中文提示');
    expect(errors.join('\n')).toContain('hardcoded UI text: 未翻译');
  });
});
