interface Picture { src: string; srcset: string; width: number; height: number; full: string }
interface Sample { original: Picture; language: string; sourceLocale: string; translations: Record<string, Picture> }
interface ShowcaseAssets {
  samples: Record<string, Sample>;
  inline: Record<string, Picture>;
  languageNames: Record<string, string>;
  labels: { original: string; translated: string; loading: string; error: string };
}

// Only the chosen images are fetched; decoding happens before the visible pair changes.
async function preload(picture: Picture, sizes: string) {
  const image = new Image();
  image.sizes = sizes;
  image.srcset = picture.srcset;
  image.src = picture.src;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([image.decode(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Image timeout')), 15000);
    })]);
    return image;
  } finally { clearTimeout(timer); }
}

// Shared by the webpage screenshot and the mobile-only manga overlay.
function setupScrubber(scrubber: HTMLElement, labels: ShowcaseAssets['labels'], prepare: () => void, persistent = false) {
  const range = scrubber.querySelector<HTMLInputElement>('input')!;
  function activate() { scrubber.dataset.active = 'true'; prepare(); }
  function setSplit(value: number) {
    range.value = String(Math.max(0, Math.min(100, Math.round(value))));
    scrubber.style.setProperty('--split', `${range.value}%`);
    range.setAttribute('aria-valuetext', `${labels.original} ${range.value}% · ${labels.translated} ${100 - Number(range.value)}%`);
  }
  function pointerSplit(event: PointerEvent) {
    if (!range.getClientRects().length || (event.pointerType !== 'mouse' && !scrubber.hasPointerCapture(event.pointerId))) return;
    const bounds = scrubber.getBoundingClientRect();
    setSplit((event.clientX - bounds.left) / bounds.width * 100);
  }
  scrubber.addEventListener('pointerenter', event => {
    if (range.getClientRects().length && event.pointerType === 'mouse') { activate(); pointerSplit(event); }
  });
  scrubber.addEventListener('pointermove', pointerSplit);
  scrubber.addEventListener('pointerdown', event => {
    if (!range.getClientRects().length) return;
    activate();
    scrubber.setPointerCapture(event.pointerId);
    pointerSplit(event);
  });
  function deactivate() { if (!persistent) delete scrubber.dataset.active; }
  scrubber.addEventListener('pointerleave', () => { if (document.activeElement !== range) deactivate(); });
  range.addEventListener('focus', activate);
  range.addEventListener('blur', deactivate);
  range.addEventListener('input', () => { activate(); setSplit(Number(range.value)); });
  setSplit(50);
  if (persistent) scrubber.dataset.active = 'true';
}

export function setupHomeShowcase() {
  const root = document.querySelector<HTMLElement>('[data-home-showcase]');
  if (!root) return;
  const assets: ShowcaseAssets = JSON.parse(root.querySelector('[data-home-assets]')!.textContent!);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const original = root.querySelector<HTMLImageElement>('[data-comparison=original] img')!;
  const translated = root.querySelector<HTMLImageElement>('[data-comparison=translated] img')!;
  const inline = root.querySelector<HTMLImageElement>('[data-inline-image]')!;
  const pair = root.querySelector<HTMLElement>('.home-image-pair')!;
  const languageSelect = root.querySelector<HTMLSelectElement>('[data-language-select]')!;
  const status = root.querySelector<HTMLElement>('[data-image-status]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-image-retry]')!;
  const inlineStatus = root.querySelector<HTMLElement>('[data-inline-status]')!;
  const scrubber = root.querySelector<HTMLElement>('[data-inline-comparison]')!;
  let sample = 'mono';
  let language = root.dataset.language!;
  let preferredLanguage = root.dataset.locale!;
  let pairLoading = false;
  let inlineLoad: Promise<void> | undefined;
  let failedSelection: [string, string] | undefined;

  const healthy = (image: HTMLImageElement) => image.complete && image.naturalWidth > 0;
  function fail(nextSample = sample, requestedLanguage = preferredLanguage) {
    failedSelection = [nextSample, requestedLanguage];
    status.textContent = assets.labels.error;
    retry.hidden = false;
  }

  // Load the hidden original only on interaction. No continuous animation loop.
  function prepareInline() {
    if (scrubber.dataset.inlineReady || inlineLoad) return;
    inlineStatus.textContent = assets.labels.loading;
    inlineLoad = preload(assets.inline.original, inline.sizes).then(image => {
      image.className = 'home-inline-original';
      image.alt = '';
      image.setAttribute('aria-hidden', 'true');
      scrubber.insertBefore(image, scrubber.querySelector('.home-inline-markers'));
      scrubber.dataset.inlineReady = 'true';
      inlineStatus.textContent = '';
    }).catch(() => { inlineStatus.textContent = assets.labels.error; })
      .finally(() => { inlineLoad = undefined; });
  }
  setupScrubber(scrubber, assets.labels, prepareInline);
  scrubber.querySelector('a')!.tabIndex = -1;
  const preparePair = () => {
    if (!healthy(original) || !healthy(translated)) return;
    const sources = [original.src, translated.src];
    const current = () => sources[0] === original.src && sources[1] === translated.src;
    void Promise.all([original.decode(), translated.decode()]).then(() => {
      if (current()) pair.dataset.inlineReady = 'true';
    }).catch(() => { if (current() && !pairLoading) fail(); });
  };
  for (const image of [original, translated]) {
    image.addEventListener('load', preparePair);
    image.addEventListener('error', () => {
      if (!pairLoading) { delete pair.dataset.inlineReady; fail(); }
    });
    if (image.complete && !image.naturalWidth) fail();
  }
  setupScrubber(pair, assets.labels, preparePair, true);
  preparePair();

  function show(image: HTMLImageElement, picture: Picture, label?: string) {
    image.srcset = picture.srcset;
    image.src = picture.src;
    image.width = picture.width;
    image.height = picture.height;
    if (label) image.alt = label;
    image.closest('a')!.href = picture.full;
    if (!reducedMotion.matches) image.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
  function select(selector: string, attribute: string, value: string) {
    root!.querySelectorAll<HTMLButtonElement>(selector).forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === value)));
  }
  function disable(selector: string, disabled: boolean) {
    root!.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(selector).forEach(control => { control.disabled = disabled; });
  }
  async function changeSample(nextSample: string, requestedLanguage: string) {
    if (pairLoading) return;
    const next = assets.samples[nextSample];
    const nextLanguage = next.translations[requestedLanguage] ? requestedLanguage : 'en';
    if (nextSample === sample && nextLanguage === language && !failedSelection && healthy(original) && healthy(translated)) { preferredLanguage = requestedLanguage; return; }
    const reloadOriginal = nextSample !== sample || !healthy(original) || !pair.dataset.inlineReady;
    pairLoading = true;
    retry.hidden = true;
    disable('button[data-sample], [data-language-choice], [data-language-select]', true);
    status.textContent = assets.labels.loading;
    pair.setAttribute('aria-busy', 'true');
    try {
      await Promise.all([
        reloadOriginal ? preload(next.original, original.sizes) : Promise.resolve(),
        preload(next.translations[nextLanguage], translated.sizes),
      ]);
      if (reloadOriginal) show(original, next.original, `${assets.labels.original} · ${next.language}`);
      show(translated, next.translations[nextLanguage], `${assets.labels.translated} · ${assets.languageNames[nextLanguage]}`);
      sample = nextSample;
      language = nextLanguage;
      preferredLanguage = requestedLanguage;
      root!.dataset.sample = sample;
      root!.dataset.language = language;
      root!.querySelector('[data-original-language]')!.textContent = next.language;
      root!.querySelector('[data-translated-language]')!.textContent = assets.languageNames[language];
      root!.querySelector('[data-original-language]')!.setAttribute('lang', next.sourceLocale);
      root!.querySelector('[data-translated-language]')!.setAttribute('lang', language);
      root!.querySelector<HTMLAnchorElement>('[data-open-original]')!.href = next.original.full;
      root!.querySelector<HTMLAnchorElement>('[data-open-translated]')!.href = next.translations[language].full;
      root!.querySelectorAll<HTMLButtonElement>('[data-language-choice]').forEach(button => {
        button.hidden = !next.translations[button.dataset.languageChoice!];
      });
      Array.from(languageSelect.options).forEach(option => { option.hidden = option.disabled = !next.translations[option.value]; });
      languageSelect.value = language;
      select('button[data-sample]', 'data-sample', sample);
      select('[data-language-choice]', 'data-language-choice', language);
      failedSelection = undefined;
      status.textContent = '';
      preparePair();
    } catch {
      fail(nextSample, requestedLanguage);
    } finally {
      pairLoading = false;
      disable('button[data-sample], [data-language-choice], [data-language-select]', false);
      pair.setAttribute('aria-busy', 'false');
    }
  }
  languageSelect.addEventListener('change', () => {
    const requestedLanguage = languageSelect.value;
    languageSelect.value = language;
    void changeSample(sample, requestedLanguage);
  });
  retry.addEventListener('click', () => {
    const [nextSample, requestedLanguage] = failedSelection ?? [sample, preferredLanguage];
    void changeSample(nextSample, requestedLanguage);
  });
  root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button) return;
    if (button.dataset.sample) void changeSample(button.dataset.sample, preferredLanguage);
    if (button.dataset.languageChoice) void changeSample(sample, button.dataset.languageChoice);
  });
  root.dataset.enhanced = 'true';
  root.querySelectorAll<HTMLElement>('[data-home-controls]').forEach(control => { control.hidden = false; });
  if (!reducedMotion.matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        (entry.target as HTMLElement).dataset.reveal = 'visible';
        observer.unobserve(entry.target);
      }
    }), { rootMargin: '0px 0px -30px 0px', threshold: 0 });
    root.querySelectorAll<HTMLElement>('[data-reveal]').forEach(section => {
      if (section.getBoundingClientRect().top > innerHeight) section.dataset.reveal = 'pending';
      observer.observe(section);
    });
  }
}
