import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it,vi} from 'vitest';
import {writeStoreLocales} from '../store-locales';

vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>(),mkdirSync:vi.fn(),writeFileSync:vi.fn()}));

describe('native shortcut store metadata',()=>{
  it('uses the existing region label for every generated browser locale',()=>{
    writeStoreLocales();
    const directory=new URL('../src/i18n/dictionaries/',import.meta.url),files=readdirSync(directory).filter(file=>file.endsWith('.json'));
    for(const file of files){
      const dictionary=JSON.parse(readFileSync(new URL(file,directory),'utf8')) as Record<string,string>;
      const expected=fileURLToPath(new URL(`../public/_locales/${file.slice(0,-5).replace('-','_')}/messages.json`,import.meta.url));
      const write=vi.mocked(writeFileSync).mock.calls.find(([path])=>path===expected);
      expect(write,`missing ${file}`).toBeDefined();
      expect(JSON.parse(String(write![1]))).toMatchObject({commandTranslateRegion:{message:dictionary['划图翻译']}});
    }
  });
});
