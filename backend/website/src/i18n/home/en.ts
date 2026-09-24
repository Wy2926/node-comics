import type { HomeCopy } from './types';

const copy: HomeCopy = {
  comparison: { title: 'One page. Many languages.', group: 'Translation examples', labels: ['Japanese original', 'Chinese', 'English', 'Korean'], loading: 'Loading image…', error: 'The image could not be loaded.', retry: 'Try again', caption: 'Recorded standard-translation results' },
  eyebrow: 'YOUR STORIES. YOUR PACE.',
  title: ['Read the story.', 'In your language.'],
  description: 'A comic reader with optional translation for supported websites and your own comic files.',
  install: 'Get the extension', seeReader: 'Explore the reader',
  desktop: 'Made for desktop reading', popupAlt: 'NodeLane Comics toolbar popup with English selected and the Translate current tab button.',
  popupCaption: 'A new chapter starts in your toolbar.',
  trust: ['Read local originals without an account.', 'Translation is online, with plan allowances.'],
  stepsTitle: 'Start from your toolbar.', stepsIntro: 'One place to choose your language and get back to the story.',
  steps: [
    ['Choose your language', 'Set the language you want to read in from the extension popup.'],
    ['Translate the current tab', 'Use page translation on supported comic pages, when you want it.'],
    ['Make room for your favorites', 'Open My comics to import a file or return to your reading.'],
  ],
  compareEyebrow: 'TAKE A CLOSER LOOK', compareTitle: 'Check the translation. Keep the original.',
  compareBody: 'Switch between a Japanese original and recorded translation results. In the reader, original and translated views stay within reach.',
  compareNote: 'A real standard-translation sample on an original AI illustration. Results vary by artwork, text and language.',
  compareLink: 'How translation works',
  readerEyebrow: 'A READER THAT FEELS LIKE YOURS', readerTitle: 'Read your way.',
  readerBody: 'Your shelf, your reading layout, your language. Take a look inside the extension.',
  galleryLabels: ['My comics', 'Reading controls', 'Translation languages', 'Supported websites', 'Appearance'],
  galleryBodies: ['Keep your comics together and pick up where you left off.', 'Choose your layout, reading direction and background.', 'Choose a target language and a translation mode.', 'Add links from supported sites or request a new website.', 'Choose the interface language, accent color and text size.'],
  galleryAlt: ['NodeLane Comics library with imported comics and continue-reading controls.', 'Comic reader with the reading settings panel open.', 'Comic reader with the target-language menu open.', 'Supported comic websites and the add-by-link input.', 'Appearance preferences with interface language, accent colors and text size.'],
  enlarge: 'View full screenshot', close: 'Close screenshot', galleryName: 'Explore extension screenshots',
  screenshotNote: 'Actual extension screenshots, shown in English. Features may differ by installed version. Comic artwork belongs to its respective owners.',
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
  privacyBody: 'Translation sends comic images to the service and uses online processing. Originals and translated results are stored privately for reuse. Check the privacy policy and plan allowances before translating.',
  privacy: 'Privacy policy', pricing: 'Plans & allowances',
  ctaTitle: 'Ready for your next page?', ctaBody: 'Get the extension, open a comic, and make yourself comfortable.',
};

export default copy;
