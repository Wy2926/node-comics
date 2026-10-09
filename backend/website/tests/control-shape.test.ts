import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css=(file:string)=>readFileSync(new URL('../src/styles/'+file,import.meta.url),'utf8');

test('website shape tokens use restrained radii without changing shared reader or Drive tokens',()=>{
  const theme=css('marketing.css');
  assert.match(theme,/body\[data-site-theme='midnight'\]/);
  for(const [token,value] of [['control',4],['card',8],['panel',10],['tab',4]]){
    assert.ok(theme.includes(`--comic-${token}-radius: ${value}px;`));
  }
  const shared=readFileSync(new URL('../public/design-tokens.css',import.meta.url),'utf8');
  assert.ok(shared.includes('--comic-control-radius: 5px 13px 5px 5px;'));
});

test('page controls and upload surfaces reuse the shared shape tokens, not pill overrides',()=>{
  for(const file of ['marketing.css','controls.css','translate.css','home.css']){
    assert.doesNotMatch(css(file),/border-radius:\s*(?:99|999)px|--comic-control-radius:\s*999px/,file);
  }
  assert.match(css('translate.css'),/\.translation-composer\s*\{[^}]*border-radius:\s*var\(--comic-panel-radius\)/);
  assert.match(css('translate.css'),/\.image-dropzone\s*\{[^}]*border-radius:\s*var\(--comic-card-radius\)/);
  assert.match(css('controls.css'),/\.billing-cycle\.billing-cycle-segmented\s*\{[^}]*border-radius:\s*var\(--comic-card-radius\)/);
});
