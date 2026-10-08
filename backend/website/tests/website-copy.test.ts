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

test('privacy, FAQ and guides agree on installation-wide HTTP/HTTPS access in every locale', () => {
  const manifest = readFileSync(new URL('../../../apps/extension/wxt.config.ts', import.meta.url), 'utf8');
  assert.match(manifest, /host_permissions:\s*\['https:\/\/\*\/\*', 'http:\/\/\*\/\*'\]/);
  assert.doesNotMatch(manifest, /optional_host_permissions/);
  const allSites = {
    'zh-CN': '所有网站', 'zh-TW': '所有網站', en: 'all websites',
    ja: 'すべてのサイト', ko: '모든 웹사이트', fr: 'tous les sites',
    es: 'todos los sitios', 'pt-BR': 'todos os sites', de: 'alle Websites',
    it: 'tutti i siti', ru: 'ко всем сайтам', pl: 'wszystkich stron',
    uk: 'до всіх сайтів', tr: 'tüm sitelere', vi: 'tất cả website',
    id: 'semua situs', ar: 'جميع المواقع',
  };
  for (const locale of locales) {
    const { policies, faqs, guides } = dictionaries[locale].documents;
    const policy = policies.privacy.sections.flatMap(section => section.paragraphs)
      .find(text => text.includes('HTTP/HTTPS'));
    assert.ok(policy, `${locale}: privacy must explain HTTP/HTTPS access`);
    const declaration = policy.split(/。|\. /)[0];
    const faq = faqs.find(item => item.id === 'website-permissions')!.answer;
    const guide = guides.find(item => item.slug === 'comic-reader-privacy')!.sections[0].paragraphs[0];
    for (const text of [faq, guide]) assert.ok(text.includes(declaration), `${locale}: inconsistent access declaration`);
    const connection = guides.find(item => item.slug === 'local-translation')!.sections[3].steps![2];
    for (const text of [policy, faq, guide, connection]) {
      assert.ok(text.includes(allSites[locale]), `${locale}: missing all-sites recovery instruction`);
    }
  }
});

test('public copy no longer instructs readers to grant on-demand website or MTU access', () => {
  const retiredPermission = /按需请求网站|尚未授予|尚未授予的網站|如浏览器弹出该地址|若瀏覽器要求該位址|連接自架 MTU 時會申請|decline new permissions|if the browser requests permission|ブラウザーがそのアドレスへのアクセス許可を求めた場合|新規権限の拒否|브라우저가 해당 주소 접근 권한을 요청하면|새 권한 거절|отклонить новые разрешения|если браузер запрашивает разрешение|odmówić nowych uprawnień|jeśli przeglądarka poprosi o pozwolenie|відхилити нові дозволи|якщо браузер запитує дозвіл|Yeni izinleri reddedebilir|Tarayıcı izin isterse|từ chối các quyền mới|nếu trình duyệt yêu cầu quyền|Kết nối MTU yêu cầu quyền|menolak izin baru|jika browser meminta izin|رفض أذونات جديدة|إذا طلب المتصفح ذلك/iu;
  for (const locale of locales) assert.doesNotMatch(JSON.stringify(dictionaries[locale]), retiredPermission, locale);
});

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
