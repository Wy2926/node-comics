// Deterministic source/CDN responses for installed-extension workflow regression.
export async function installFixture(browser, worker, setup) {
  const origin = 'https://comickz.co.uk', slug = '00-one-piece-episode-a', title = 'ComicK fixture';
  const cdn = 'https://cdn1.comicknew.pictures', cover = `${cdn}/${slug}/covers/fixture.webp`;
  const rows = [
    {id: 1, hid: 'First', chap: '1', vol: '2', lang: 'en', title: 'Beginning', group_name: ['Fixture']},
    {id: 2, hid: '6X6e3BMq', chap: '4.5', vol: '2', lang: 'en', title: 'Sample', group_name: ['Fixture']},
    {id: 3, hid: 'Other', chap: '4.5', vol: '2', lang: 'es-419', title: 'Sample', group_name: ['Fixture']},
  ];
  const work = {id: 42, slug, title, chapter_count: rows.length, default_thumbnail: cover, lang_list: '{en,es-419}'};
  const script = (id, value) => `<script type="application/json" id="${id}">${JSON.stringify(value)}</script>`;
  const responses = {[origin + '/api/search?q=one+piece']: {body: JSON.stringify({data: [work], next_cursor: null}), contentType: 'application/json'},
    [origin + `/api/comics/${slug}/chapter-list?chapOrder=asc&page=1`]: {body: JSON.stringify({data: rows,
      pagination: {current_page: 1, per_page: 60, last_page: 1, total: rows.length}}), contentType: 'application/json'},
    [origin + `/comic/${slug}`]: {body: '<!doctype html><h1>ComicK fixture</h1>' + script('comic-data', work), contentType: 'text/html'}};
  const png = await setup.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 900;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#daeafe'; ctx.fillRect(0, 0, 600, 900);
    ctx.fillStyle = '#1e3a8a'; ctx.fillRect(50, 50, 500, 360); ctx.fillStyle = '#fff'; ctx.font = '36px sans-serif';
    ctx.fillText('ComicK adapter fixture', 70, 220); return canvas.toDataURL('image/png').split(',')[1];
  });
  responses[cover] = {body: png, base64: true, contentType: 'image/png'};
  for (const row of rows) {
    const images = Array.from({length: 8}, (_, i) => ({w: 600, h: 900, url: `${cdn}/${slug}/${row.vol}_${row.chap}/${row.lang}/fixture/${i}.webp`}));
    for (const image of images) responses[image.url] = {body: png, base64: true, contentType: 'image/png'};
    responses[`${origin}/comic/${slug}/${row.hid}-chapter-${row.chap}-${row.lang}`] = {contentType: 'text/html', body:
      '<!doctype html><meta charset="utf-8"><h1>ComicK fixture</h1>' + script('sv-data', {chapter: {...row, comic: work, external_type: null, images}}) +
      images.map(image => `<img width="600" height="900" src="${image.url}">`).join('')};
  }
  await browser.route('https://**/*', async route => {
    const data = responses[route.request().url()];
    await route.fulfill(data ? {status: 200, contentType: data.contentType, body: data.base64 ? Buffer.from(data.body, 'base64') : data.body}
      : {status: 503, body: '{}'});
  });
  await worker.evaluate(responses => {
    globalThis.fetch = async input => {
      const data = responses[String(typeof input === 'string' ? input : input.url ?? input)];
      return data ? new Response(data.base64 ? Uint8Array.from(atob(data.body), c => c.charCodeAt(0)) : data.body,
        {headers: {'Content-Type': data.contentType}}) : new Response('{}', {status: 503});
    };
  }, responses);
}
