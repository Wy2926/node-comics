import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: 'One page. Many languages.', group: 'Translation examples', labels: ['Japanese original', 'Chinese', 'English', 'Korean'], loading: 'Loading image…', error: 'The image could not be loaded.', retry: 'Try again', caption: 'Recorded standard-translation results' },
  eyebrow: 'YOUR STORIES. YOUR PACE.',
  title: ["Read & translate manga.","Right in your browser."],
  description: "Read manga with AI translation in Chrome, Edge and Firefox. Open supported websites or your own CBZ, CBR, PDF and DRM-free MOBI files, and compare every translated page with its original.",
  install: 'Get the extension', seeReader: 'Explore the reader',
  readerPath: 'Read comics with the extension', readerAccess: 'Read local originals free, without an account. Official translation uses your account allowance; you can also connect your own local service.',
  webAccess: 'Try as a guest, or sign in to use your account allowance. The image workspace shows your available uses.',
  desktop: 'Made for desktop reading', popupAlt: 'NodeLane Comics toolbar popup with English selected and the Translate current tab button.',
  platformHeading: 'Your desktop browser, supported', guestEyebrow: 'ONLINE IMAGE TRANSLATION',
  popupCaption: 'A new chapter starts in your toolbar.',
  trustLinks: [['Open source', 'Browse the code and report issues on GitHub.'], ['Official installation', 'Chrome and Firefox stores, plus an Edge package.'], ['Images & privacy', 'Read how images are processed and retained.']],
  quickStart: {
    eyebrow: 'VIDEO QUICK START', title: 'Follow along. Start reading.', description: 'Explore finding, importing, reading and translating comics with our existing tutorials.',
    watch: 'Watch tutorial', channel: 'Visit our YouTube channel',
    clips: [
      { title: 'Find, import and read offline', description: 'Go from adding a comic to offline reading, and learn how to translate while you read.', language: 'Chinese video' },
      { title: 'Start reading and translating', description: 'An English introduction to the reader, original pages and translation.', language: 'English video' },
    ],
  },
  stepsTitle: 'Three steps to your next comic.', stepsIntro: 'Install the extension, add a comic, and read at your own pace.',
  steps: [
    ['Install the extension', 'Install from the Chrome or Firefox store, or get the Edge package.'],
    ['Import or add a comic', 'Import local files or comics from Google Drive, or add a comic from a supported website.'],
    ['Translate when you want to', 'Read originals without an account. Choose a translation service and compare with the original as you read.'],
  ],
  compareEyebrow: 'TAKE A CLOSER LOOK', compareTitle: 'Check the translation. Keep the original.',
  compareBody: 'Switch between a Japanese original and recorded translation results. In the reader, original and translated views stay within reach.',
  compareNote: 'A real standard-translation sample on an original AI illustration. Results vary by artwork, text and language.',
  compareLink: 'How translation works',
  readerEyebrow: 'SIX PANELS. A LOOK INSIDE.', readerTitle: 'Your next comic. Your next page.',
  readerBody: 'Find a new story, add it to your shelf, and cache it to read offline. Explore the real interfaces from the project overview.',
  galleryLabels: ['My comics', 'Discover comics', 'Search comics', 'Offline center', 'Reader & chapters', 'Original & translation'],
  galleryBodies: ['Import, search, and manage comics, then pick up where you left off.', 'Browse charts, read synopses, check ratings and alternative titles, and find your next comic.', 'Search websites by title or alternative title, or translate the title before choosing a source.', 'Track chapter caching and storage use, and pause or resume whenever you need.', 'Open the chapter directory to check languages, page counts, caching, and reading status.', 'Compare the original and translation side by side, or return to the original view.'],
  galleryAlt: ['English comic library interface and reading progress.', 'English comic discovery charts and title details.', 'English comic title search, website selection, and search results.', 'English offline caching tasks, chapter progress, and storage use.', 'English reader with the multilingual chapter directory expanded.', 'English reader with the original and Chinese translation side by side.'],
  enlarge: 'View full screenshot', close: 'Close screenshot', galleryName: 'Explore extension screenshots',
  screenshotNote: 'Real screenshots shared with the project overview, shown in English. Open any screenshot to view the full original. Features may differ by version; comic artwork belongs to its respective owners.',
  sourcesEyebrow: 'FROM YOUR FILES OR THE WEB', sourcesTitle: 'Bring a comic you can access.',
  sources: [
    ['Your comic files', 'Import supported comic archives and documents into your shelf. Read the original locally, without signing in.', 'Import a local comic'],
    ['Supported websites', 'Add a comic link from a supported site. Website imports use dedicated adapters; support varies by site.', 'See website import instructions'],
  ],
  modesEyebrow: 'TRANSLATE WHEN YOU WANT TO', modesTitle: 'Two ways to read across languages.',
  modes: [
    ['Standard translation', 'Detects text, translates it, and places it back into the page with local background repair.'],
    ['AI redraw', 'Uses an image model to translate and redraw the page. It can also change details in the artwork.'],
  ],
  controlNote: 'New comics open in the original view. Choose a translation mode when you are ready.',
  privacyTitle: 'Know what happens to your pages.',
  privacyBody: 'Official translation sends selected images to the server; originals are removed after the task completes, fails or is cancelled. Private account results are retained while valid requests remain; guest server results are kept for 24 hours after the task ends, and translations saved locally are unaffected by that limit. When you connect a local translation service, that service determines image processing and retention.',
  privacy: 'Privacy policy', pricing: 'Plans & allowances',
  ctaTitle: 'Ready for your next page?', ctaBody: 'Get the extension, open a comic, and make yourself comfortable.',
};

export default copy;
