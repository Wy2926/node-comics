interface Picture { src: string; srcset: string; width: number; height: number }
interface Sample { original: Picture; language: string; translations: Record<string, Picture> }
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
  const status = root.querySelector<HTMLElement>('[data-image-status]')!;
  const inlineStatus = root.querySelector<HTMLElement>('[data-inline-status]')!;
  const scrubber = root.querySelector<HTMLElement>('[data-inline-comparison]')!;
  let sample = 'mono';
  let language = root.dataset.language!;
  let pairLoading = false;
  let inlineLoad: Promise<void> | undefined;

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
    if (!original.complete || !original.naturalWidth || !translated.complete || !translated.naturalWidth) return;
    void Promise.all([original.decode(), translated.decode()]).then(() => { pair.dataset.inlineReady = 'true'; }).catch(() => {});
  };
  original.addEventListener('load', preparePair);
  translated.addEventListener('load', preparePair);
  setupScrubber(pair, assets.labels, preparePair, true);
  preparePair();

  function show(image: HTMLImageElement, picture: Picture, label?: string) {
    image.srcset = picture.srcset;
    image.src = picture.src;
    image.width = picture.width;
    image.height = picture.height;
    if (label) image.alt = label;
    image.closest('a')!.href = picture.src;
    if (!reducedMotion.matches) image.animate([{ opacity: .55 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }
  function select(selector: string, attribute: string, value: string) {
    root!.querySelectorAll<HTMLButtonElement>(selector).forEach(button => button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === value)));
  }
  function disable(selector: string, disabled: boolean) {
    root!.querySelectorAll<HTMLButtonElement>(selector).forEach(button => { button.disabled = disabled; });
  }
  async function changeSample(nextSample: string, nextLanguage: string) {
    if (pairLoading || (nextSample === sample && nextLanguage === language)) return;
    const next = assets.samples[nextSample];
    if (!next.translations[nextLanguage]) nextLanguage = 'en';
    pairLoading = true;
    disable('[data-sample], [data-language-choice]', true);
    status.textContent = assets.labels.loading;
    pair.setAttribute('aria-busy', 'true');
    try {
      await Promise.all([
        nextSample !== sample ? preload(next.original, original.sizes) : Promise.resolve(),
        preload(next.translations[nextLanguage], translated.sizes),
      ]);
      if (nextSample !== sample) show(original, next.original, `${assets.labels.original} · ${next.language}`);
      show(translated, next.translations[nextLanguage], `${assets.labels.translated} · ${assets.languageNames[nextLanguage]}`);
      sample = nextSample;
      language = nextLanguage;
      root!.querySelector('[data-original-language]')!.textContent = next.language;
      root!.querySelector('[data-translated-language]')!.textContent = assets.languageNames[language];
      root!.querySelectorAll<HTMLButtonElement>('[data-language-choice]').forEach(button => {
        button.hidden = !next.translations[button.dataset.languageChoice!];
      });
      select('[data-sample]', 'data-sample', sample);
      select('[data-language-choice]', 'data-language-choice', language);
      status.textContent = '';
    } catch {
      status.textContent = assets.labels.error;
    } finally {
      pairLoading = false;
      disable('[data-sample], [data-language-choice]', false);
      pair.setAttribute('aria-busy', 'false');
    }
  }
  root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button) return;
    if (button.dataset.sample) void changeSample(button.dataset.sample, language);
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
