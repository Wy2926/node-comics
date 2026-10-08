import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    slug: 'local-translation',
    title: 'Local manga translation: connect manga-translator-ui to NodeLane',
    description: 'Set up the manga-translator-ui Web service, connect it to NodeLane, and translate your first comic page. Includes connection, login, waiting and cache troubleshooting.',
    category: 'Local translation tutorial', minutes: 8, published: '2026-09-28', updated: "2026-10-08",
    related: ['local-manga-translator', 'local-comics', 'translation-troubleshooting'],
    sections: [
      { title: 'Before you start', paragraphs: [
        'NodeLane Comics handles reading in your browser; manga-translator-ui (MTU) processes the images. Your own MTU channel needs no NodeLane account and uses no official translation allowance. Hardware, models and third-party API costs remain yours.',
        'You need the latest desktop browser extension, an installed MTU service with its dependencies, and that service’s username and password. This tutorial uses http://127.0.0.1:8000 on the same computer as the browser. Use your actual port if it differs.'
      ], links: [{label: 'Download NodeLane Comics', href: '/download/'}, {label: 'Official MTU installation: Windows', href: 'https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable'}, {label: 'Official MTU installation: Linux / macOS', href: 'https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos'}] },
      { title: '1. Start the MTU Web service', paragraphs: [
        'The extension needs an HTTP Web service. Opening the MTU desktop window alone is not enough. After installing MTU, run this command in its project directory and keep the service running. Skip this command if you already run the Web service through Docker or another method.',
        'This example does not enable GPU processing. Add --use-gpu only after configuring a supported GPU environment as described upstream. Model, driver and hardware requirements depend on your MTU version.'
      ], code: 'uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000', links: [{label: 'Official MTU Web launch instructions', href: 'https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access'}] },
      { title: '2. Translate a test image in MTU first', paragraphs: [
        'Open http://127.0.0.1:8000 in your browser, complete MTU’s account setup and sign in. If it requires an initial password change, complete that in MTU before connecting the extension. These are MTU credentials, separate from your NodeLane account.',
        'Configure the translator, models and any required API keys on the server, then confirm that a test image produces a translated image. The extension sets the target language and uses server defaults for other translation settings. Make sure the Web service uses the intended defaults. Do not enter a model API key in the extension’s password field.'
      ], links: [{label: 'Official MTU project and documentation', href: 'https://github.com/hgmzhn/manga-translator-ui'}] },
      { title: '3. Add a translation channel in the extension', paragraphs: [
        'Open the extension’s settings and find Translation channels. After a successful connection, the extension saves the service password and token locally on this computer. When reconnecting with the same service address and username, leave the password blank to reuse the saved password. Enter it again if the address or username changes, or if the password has changed or is no longer valid. Older profiles that only contain a token need a password once on their first reconnection. Labels below describe the corresponding controls in your interface language. Saving passwords and reconnecting with a blank password require extension 0.10.2 or later; earlier versions require the password on each reconnection.'
      ], steps: [
        'Choose Add translation channel and confirm manga-translator-ui as the service. Optionally give it a recognizable name, such as “My computer”.',
        'Enter http://127.0.0.1:8000 as the service address. Use the service root, without /auth/login, /translate/with-form/image or an administration page path.',
        'Enter your MTU username and password, then choose Connect and use. Connecting does not request a separate site permission; if browser access is restricted, restore access to all websites in the extension settings and retry.',
        'Check that Current channel shows the new service. You may save multiple service profiles, but only the selected channel is used at a time.'
      ] },
      { title: '4. Read your first translated page', paragraphs: [
        "Open a local book, OPDS item or supported website in the reader. Choose your target language and the MTU channel, then test the current image. Both official and MTU channels provide standard image translation in the current extension.",
        "Current images take priority within a limited nearby reading window. One MTU channel processes images serially. Switch back to originals or compare side by side without losing your position; reader, website and region translation share the selected channel.",
        'If a page fails, resolve its reported issue before retrying manually. Closing a page or losing the connection does not prove that MTU stopped computing. Avoid repeated submissions while the service may still be busy.'
      ], links: [{label: 'Importing local comics and supported formats', href: '/guides/local-comics/'}] },
      { title: 'Troubleshoot connections, login and long waits', paragraphs: [
        'Check MTU itself before retrying in the extension. Do not share passwords, tokens or private comic files when reporting a problem.'
      ], table: { headers: ['Symptom', 'What to check'], rows: [
        ['The service address does not open', 'Check that the Web service is running and the port is correct. 127.0.0.1 means the computer running the browser; a different device needs its own reachable address.'],
        ['The page opens, but the extension cannot connect', 'Check the root address, browser access permission and whether your MTU version provides compatible account login and image translation endpoints.'],
        ['Wrong credentials or initial password change required', 'Sign in to MTU or change the initial password there, then reconnect. Use MTU credentials, not a NodeLane password or model API key.'],
        ['A previous connection now reports an expired login', 'Choose Reconnect in channel settings. For the same service address and username, leave the password blank to reuse it. Enter it again if the address or username changes, the password has changed or is no longer valid, or an older profile only has a token. The extension does not silently resend the previous translation. Saving passwords and reconnecting with a blank password require extension 0.10.2 or later; earlier versions require the password on each reconnection.'],
        ['Connected, but translation keeps waiting', 'Check model downloads, engine loading, queues, API balance and hardware resources. Test the same configuration in MTU. Connecting only verifies login.'],
        ['Interrupted, timed out or returned something other than an image', 'Check the MTU task, proxy timeout and response. Retry the failed page manually after fixing the cause. The extension does not restore results automatically from MTU history.']
      ] } },
      { title: 'Cache, offline use and where images go', paragraphs: [
        'Local-channel results are cached in this browser’s local storage. Clearing the cache, or setting the translated-image cache budget to zero and closing pages that still hold results, can remove them. Missing results require manual retranslation; the extension cannot fetch them back from MTU.',
        'Images go to the selected MTU service. Running MTU locally does not guarantee offline translation: online translators, OCR or image models may send text or images to their providers. Offline generation requires available originals, downloaded models and a pipeline with no online dependencies.'
      ], links: [{label: 'Local manga translation: costs, privacy and offline requirements', href: '/guides/local-manga-translator/'}] }
    ]
  },
  {
    slug: 'local-manga-translator',
    title: 'Choosing a local manga translator for browser reading',
    description: 'Use manga-translator-ui with a browser comic reader: understand local manga translation, hardware and API costs, privacy, offline requirements, and support for CBZ and PDF reading.',
    category: 'Local translation guide', minutes: 6, published: '2026-09-28', updated: "2026-10-04",
    related: ['local-translation', 'translation-modes', 'local-comics'],
    sections: [
      { title: 'Manga translation needs an image workflow', paragraphs: [
        'Dialogue in manga is usually part of the artwork. A browser’s text translation cannot directly put translated words back into speech bubbles. Classic image translation detects text, reads it with OCR, translates it, removes the original lettering and lays out the result.',
        'If you already have a computer capable of running a translation service, you can use manga-translator-ui for image processing and NodeLane Comics for continuous browser reading. The extension sends images from the current reading window to the selected service and displays returned translations in place.'
      ] },
      { title: 'Local reading, a local service and offline translation', paragraphs: [
        '“Local” can describe where a file lives or where a service runs. Follow the entire processing path to understand what happens to the content.'
      ], table: { headers: ['Term', 'What it means'], rows: [
        ['Local comic reading', "Import CBZ/ZIP, CBR/RAR, PDF, supported DRM-free MOBI or EPUB in the browser. Original reading does not call a translation service; EPUB translation covers embedded bitmap images only."],
        ['A local MTU service', 'Images go to your MTU installation, which may use local models or external APIs.'],
        ['Fully offline translation', 'Originals, models and dependencies are available locally, and every processing stage works without online services. Verify the whole pipeline yourself.']
      ] } },
      { title: 'Self-hosted MTU or the official channel?', paragraphs: [
        'A local channel suits readers who already run MTU or want to maintain their own models and service. The official channel reduces setup and maintenance. Try a few pages with either option before judging the results.'
      ], table: { headers: ['Consideration', 'Your MTU channel', 'Official NodeLane channel'], rows: [
        ['Account', 'MTU credentials; no NodeLane login', 'NodeLane login required'],
        ['Setup', 'Install, run and configure your service', 'Translation service maintained by NodeLane'],
        ['Extension modes', 'Currently classic translation only', "Standard image translation with the current account allowance"],
        ['Costs', 'No official allowance used; hardware, power and chosen APIs are yours', 'Official plans and allowance rules'],
        ['Missing result cache', 'Manual retranslation required', 'Eligible official results can be downloaded again while available']
      ] }, links: [{label: 'Connect your local service', href: '/guides/local-translation/'}, {label: 'Official plans and allowances', href: '/pricing/'}] },
      { title: 'Is local manga translation free? Which GPU do you need?', paragraphs: [
        'MTU translations do not consume NodeLane’s official allowance, but that does not make the whole workflow cost-free. Online models may charge per request; local models need hardware, storage and processing time. Check your chosen engines before estimating costs.',
        'There is no single memory requirement for every setup. Models, image resolution, OCR and inpainting engines affect resource use and processing time. Follow MTU’s installation guidance for your operating system and hardware, then test one clear page. No fixed speed or universal hardware compatibility is promised.'
      ], links: [{label: 'Official MTU project and installation guides', href: 'https://github.com/hgmzhn/manga-translator-ui'}] },
      { title: 'Check Japanese manga, Korean comics and long strips', paragraphs: [
        'Start with a clear original and check whether the configured OCR supports its language. Vertical dialogue, handwritten effects, complex backgrounds and low-resolution scans can cause missing text. Large vertical strips may also take more memory and time.',
        'Choose an available target language and compare one or two translated pages against the originals. Check omissions, names, tone and bubble layout. Results depend on the models and settings in MTU; a local connection does not itself improve translation accuracy.'
      ] },
      { title: 'Where are images uploaded, and what works offline?', paragraphs: [
        'With MTU selected, the extension sends translation images directly to that configured service rather than through NodeLane’s official translation service. Whether MTU forwards text or images to a model provider depends on its enabled engines.',
        'Imported local comics and cached translations remain readable while those resources are available. Generating new translations offline requires a running local service and a fully offline processing pipeline. Website originals must also be cached in advance. Keeping result caches reduces repeated work, but a cache is not a permanent backup.'
      ], links: [{label: 'Image uploads and extension permissions', href: '/guides/comic-reader-privacy/'}] },
      { title: 'Start with one page', paragraphs: [
        'Start MTU’s Web service and translate one image in its own interface. Then add the service address and account in NodeLane settings, connect, and select classic translation and a target language.',
        'If connecting fails, check the address and browser permission. If login works but no image appears, check the service’s translation configuration. A small trial tells you more about suitability for everyday reading than a general speed claim.'
      ], links: [{label: 'Follow the local translation tutorial', href: '/guides/local-translation/'}, {label: 'Download the comic reader and translator', href: '/download/'}] }
    ]
  }
];
