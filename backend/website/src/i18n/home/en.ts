import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: 'One page. Many languages.', group: 'Translation examples', labels: ['Japanese original', 'Chinese', 'English', 'Korean'], loading: 'Loading image…', error: 'The image could not be loaded.', retry: 'Try again', caption: 'Recorded standard-translation results' },
  eyebrow: "MANGA TRANSLATOR EXTENSION",
  title: ["Translate manga.","Keep reading."],
  description: "A manga translator extension for desktop Chrome, Edge and Firefox. Translate comic images with NodeLane’s cloud service and compare with the original while you read.",
  install: 'Get the extension', seeReader: "See translation in action",
  readerPath: "Your comics and libraries in one reader", readerAccess: "Free to install. Cloud translation requires an account, with limits for free and paid plans.",
  webAccess: 'Try as a guest, or sign in to use your account allowance. The image workspace shows your available uses.',
  desktop: 'Made for desktop reading', popupAlt: 'NodeLane Comics toolbar popup with English selected and the Translate current tab button.',
  platformHeading: 'Your desktop browser, supported', guestEyebrow: 'ONLINE IMAGE TRANSLATION',
  popupCaption: "Translate the current tab, select an area, or open a supported comic in the reader.",
  trustLinks: [['Open source', 'Browse the code and report issues on GitHub.'], ['Official installation', "Chrome, Edge and Firefox stores and installation packages."], ['Images & privacy', 'Read how images are processed and retained.']],
  quickStart: {
    eyebrow: 'VIDEO QUICK START', title: 'Follow along. Start reading.', description: 'Explore finding, importing, reading and translating comics with our existing tutorials.',
    watch: 'Watch tutorial', channel: 'Visit our YouTube channel',
    clips: [
      { title: 'Find, import and read offline', description: 'Go from adding a comic to offline reading, and learn how to translate while you read.', language: 'Chinese video' },
      { title: 'Start reading and translating', description: 'An English introduction to the reader, original pages and translation.', language: 'English video' },
    ],
  },
  stepsTitle: "From installation to translation in three steps.", stepsIntro: "Install the extension, open a book or connect a source, and choose how you want to read.",
  steps: [["Install the extension","Get it from the official store for Chrome, Edge or Firefox."],["Open your manga","Read a local comic or open a supported manga website."],["Choose a language","Translate images with your selected service and keep the original alongside."]],
  compareEyebrow: 'TAKE A CLOSER LOOK', compareTitle: 'Check the translation. Keep the original.',
  compareBody: "Compare a Japanese original with recorded standard-translation results. In the reader, switch views or read the original and translation side by side while keeping your place.",
  compareNote: 'A real standard-translation sample on an original AI illustration. Results vary by artwork, text and language.',
  compareLink: 'How translation works',
  readerEyebrow: 'SIX PANELS. A LOOK INSIDE.', readerTitle: 'Your next comic. Your next page.',
  readerBody: "Discover titles, search supported sites, keep books on your shelf and save chapters offline. The screenshots show real interfaces; OPDS and EPUB also share the reader’s tools and preferences.",
  galleryLabels: ['My comics', 'Discover comics', 'Search comics', 'Offline center', 'Reader & chapters', 'Original & translation'],
  galleryBodies: ["Import and manage your comics, then continue from the saved position.", "Browse AniList charts, synopses, ratings and alternate titles; title and synopsis translations are available.", "Search supported websites by title or alternate title, or translate the title before choosing a source.", "Cache selected languages and chapters, track storage, pause, resume and retry missing pages.", "Browse chapters and language options, with page counts, cache status and reading progress.", "Compare original and standard-translated images side by side, or switch back without losing your place."],
  galleryAlt: ['English comic library interface and reading progress.', 'English comic discovery charts and title details.', 'English comic title search, website selection, and search results.', 'English offline caching tasks, chapter progress, and storage use.', 'English reader with the multilingual chapter directory expanded.', 'English reader with the original and Chinese translation side by side.'],
  enlarge: 'View full screenshot', close: 'Close screenshot', galleryName: 'Explore extension screenshots',
  screenshotNote: "Real product screenshot: English interface, original and Chinese translation. Results vary. Comic artwork belongs to its respective owners.",
  sourcesEyebrow: "LOCAL FILES, CLOUD LIBRARIES AND WEBSITES", sourcesTitle: "Open the books you already have access to.",
  sources: [
    [
      "Local comics and EPUBs",
      "Read CBZ/ZIP, CBR/RAR, PDF, DRM-free MOBI and EPUB. EPUB translation covers embedded bitmap images, not body text.",
      "Explore file formats"
    ],
    [
      "Google Drive",
      "Select CBZ/ZIP or DRM-free MOBI from your own Drive, and read supported books on demand.",
      "Read the source guide"
    ],
    [
      "OPDS libraries",
      "Connect several libraries, browse or search on demand, and read supported books. Progress sync is available when the source supports it.",
      "Connect an OPDS library"
    ],
    [
      "Supported comic websites",
      "Find a title, check source access conditions and add it to your shelf. Other pages can use image translation or a visible-area selection without a library import.",
      "Translate and read websites"
    ]
  ],
  modesEyebrow: "STANDARD IMAGE TRANSLATION", modesTitle: "Choose where your images are translated.",
  modes: [
    ["NodeLane official service", "Sign in and use your account allowance. Images are processed by the official service; valid results can be retrieved again when a local cache is missing."],
    ["Your manga-translator-ui service", "Connect your own MTU with its service address and credentials. No NodeLane account or official allowance is needed; processing and any API costs depend on your setup."],
  ],
  controlNote: "New comics open as originals. The extension uses standard translation for comic images; choose a channel when you need it.",
  privacyTitle: "Read for free. Choose your translation plan.",
  privacyBody: "NodeLane Comics offers a free extension and account-based cloud translation. Rate and service-capacity limits apply. Check current availability, full benefits and billing terms before subscribing.",
  privacy: 'Privacy policy', pricing: "Compare Free and PLUS / Pro",
  ctaTitle: "Make sense of your next page.", ctaBody: "Install NodeLane Comics for desktop Chrome, Edge or Firefox.",
};

export default copy;
