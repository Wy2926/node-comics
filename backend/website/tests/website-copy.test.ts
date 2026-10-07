import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dictionaries, locales } from '../src/i18n';
import { homeCopy } from '../src/i18n/home';
import { translationCopy } from '../src/i18n/translate';
import { commerceCopy } from '../src/i18n/commerce';
import { billingCopy, billingBenefitCopy, offerBenefits, renewalCopy, trialCopy } from '../src/lib/billing';

const retiredFeature = /redraw|重[绘繪]|再描画|다시\s*그리|neuzeich|redessin|redibuj|redesenh|ridisegn|przerys|перерис|перемал|yeniden\s*çiz|gambar\s+ulang|vẽ\s+lại/iu;
const clean = (text: string, label: string) => assert.equal(retiredFeature.exec(text)?.[0], undefined, label);

test('all website locales omit the retired image feature from prose, metadata and account copy', () => {
  for (const locale of locales) {
    for (const [name, copy] of Object.entries({
      dictionary: dictionaries[locale], home: homeCopy[locale],
      workspace: translationCopy[locale], commerce: commerceCopy(locale),
    })) clean(JSON.stringify(copy) ?? '', `${locale}: ${name}`);
    clean(JSON.stringify(billingCopy(locale)), `${locale}: billing labels`);
    clean(JSON.stringify(billingBenefitCopy(locale)), `${locale}: billing benefits`);
    for (const pages of [0, 300]) {
      const offer = { hourly_image_limit: 1200, monthly_redraw_pages: pages, interval: 'year' as const };
      clean(offerBenefits(offer, locale), `${locale}: offer benefits`);
      clean(renewalCopy(offer, locale), `${locale}: renewal`);
    }
    clean(trialCopy(7, locale), `${locale}: trial`);
  }
});

test('the workbench only starts standard translation and preserves existing result recovery', () => {
  const source = readFileSync(new URL('../src/components/TranslationWorkbench.tsx', import.meta.url), 'utf8');
  assert.equal(/setMode|\bt\.mode|\bt\.redraw|value="redraw"/.test(source), false);
  assert.match(source, /meta\.mode = 'classic'/);
  assert.match(source, /if \(!snapshot\)\s*\{\s*\/\/[^\n]*\n\s*if \(meta\.mode !== 'classic'\) throw/);
  assert.match(source, /async function again\(meta: RecordMeta\)\s*\{\s*if \(meta\.mode !== 'classic'/);
  assert.match(source, /row\.mode === 'classic' && row\.state === 'failed'/);
  assert.match(source, /const blob =[\s\S]*?await readImages\(meta\.id\)/);
  assert.match(source, /translationArchive\(records, readResult\)/);
  assert.doesNotMatch(source, /function Preview|<Preview|setView|setZoom|type="range"/);
  for (const locale of locales) {
    assert.ok(translationCopy[locale].files);
    assert.match(translationCopy[locale].downloadAll, /ZIP/);
    assert.equal('previewTitle' in translationCopy[locale], false);
  }
});
