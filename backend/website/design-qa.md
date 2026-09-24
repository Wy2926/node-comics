# Homepage design QA — 2026-09-24

**Final result: passed**

Scope: existing Astro homepage in English, simplified/traditional Chinese, Japanese and Korean. This is a new homepage composition grounded in the supplied extension screenshots and existing site tokens, not a pixel-for-pixel clone of the extension. No deployment, extension installation, payment or live translation was performed.

## Visual references and evidence

- Source content/layout brief: `../../docs/marketing/WEBSITE_BRIEF.md`.
- Source visual truth: `src/assets/product/06-browser-popup.png` (420 × 600) and `02-reading-controls.png` (2042 × 1214), plus the other four user-supplied screenshots in the same directory. Shared colors, typeface and borders come from `public/design-tokens.css`.
- Implementation: `http://127.0.0.1:4321/en/`, served with `npm run preview` from the production build.
- Browser viewport: 1280 × 720 CSS pixels; no viewport override. Captured viewport JPEGs are 1265 × 712; full-page JPEG is 1265 × 4854. No additional density normalization or raster editing was applied to the browser captures.
- Full-view evidence: `../../artifacts/marketing/2026-09-24/website/en-full-page.jpg`, with the library selected and English translation loaded.
- Focused evidence: `en-hero.jpg`, `en-reading.jpg`, `en-dialog.jpg` in the same evidence directory. Supplied Popup and reading screenshots were opened together with the corresponding implementation captures in one comparison input. The Popup is uniformly scaled to 332 × 474 CSS pixels inside its frame; reading-preview crops are intentional, with the full source available in the dialog.
- Locale captures: `zh-tw-hero.jpg`, `ja-hero.jpg`, `ko-hero.jpg`; simplified Chinese was also opened and visually inspected. Screenshot UI itself remains English and is identified as such in localized captions.
- Runtime observations: `browser-checks.json`; command logs: `../website-build.log` and `../website-tests.log` relative to the evidence directory.

## Findings and comparison history

1. **Resolved P2 — Product screenshot detail too small.** The first gallery displayed the entire desktop capture, including large unused margins. Changed the preview to deliberate source crops; reading and translation settings appear beside their source comic region. Reopened source and final `en-reading.jpg`: labels, blue selected controls, comic pixels and aspect ratios are preserved. Full screenshots remain available. Homepage composition intentionally differs from the extension layout.
2. **Resolved P2 — Korean sentence broke inside its final word.** Initial Korean hero placed the final syllable alone on a line. Applied `word-break: keep-all` only to the Korean homepage. Rebuilt and recaptured `ko-hero.jpg`; complete words now wrap together without horizontal overflow.
3. **Resolved accessibility/build finding — Cropped images lacked nonempty alt text.** Added localized descriptive alt text and an accessible group label; final static validation passed for all five homepages.
4. **Development-only transient error investigated.** During the crop-prop change, an old hydrated gallery received new component code before its updated server props. A full reload resolved it. Final verification used a new tab loaded exclusively from the production build; repeated gallery and comparison actions produced zero console errors.

No actionable P0/P1/P2 visual or interaction findings remain in the tested desktop flow.

## Required fidelity surfaces

- **Fonts/typography:** Reuses the existing Segoe UI / Microsoft YaHei / system stack and established bold display treatment. Checked all five hero headings and navigation; no truncation or horizontal overflow. Korean word wrapping corrected.
- **Spacing/layout:** 1180 px maximum content container, consistent section spacing, restrained hard shadows, stable gallery height and reserved comparison aspect ratio. Inspected the full page for section order, alignment and CTA placement.
- **Colors/tokens:** Existing blue `#1769b3`, ink `#202d43`, light canvas and white surfaces are reused. Focus and pressed states are visible. No new brand palette or competing component system.
- **Images:** Six actual supplied PNGs retained in source, with Astro-generated WebP output. Popup is not redrawn. Preview crops preserve proportions; full screenshot dialog preserves source aspect ratio. Source comic artwork and original AI illustration are explicitly distinguished.
- **Copy/content:** All new localized homepage strings, image labels, comparison controls, loading/error/retry messages and screenshot captions live in five separate files under `src/i18n/home/`. Page components contain no translation dictionaries. Scope, online translation, plan allowances and image reuse are described without invented ratings, site coverage or store-approval claims.

## Interactions and checks

- Hero gallery anchor reaches the expected section under the sticky header.
- All five gallery choices update image, description and selected state.
- Full screenshot dialog opens; Escape closes it and returns focus to its trigger.
- Japanese original, Chinese, English and Korean comparison controls load the corresponding image without changing the reserved panel dimensions.
- Header language menu switches English to simplified Chinese; all five homepage routes were opened and inspected.
- Main CTA reaches localized installation instructions. ZIP link resolves to the existing public release URL, including in local preview. External download bytes were verified earlier in this task; this QA did not reinstall the extension.
- Fresh production tab: zero console errors, expected images decoded, no horizontal overflow at 1280 × 720.
- `npm test`: 13/13 passed, including complete locale keys, nonempty strings and matching screenshot/translation entry counts.
- `npm run build`: zero Astro errors/warnings; 110 static pages validated for metadata, JSON-LD, local links, images and indexing boundaries.

## Boundaries and follow-up polish

- Desktop browser validation only. No new narrow-screen acceptance scope, production deployment, payment/account testing or translation-provider test.
- Existing comparison failure/retry handling is preserved and its strings localized; a fresh network-failure injection was not part of this homepage QA.
- Screenshots reflect the supplied extension build, which may differ from the public ZIP version. The gallery states this limitation.

Implementation checklist: complete homepage, separate dictionaries, real assets, functional gallery/dialog/comparison, localized installation entry, browser verification and static validation.

final result: passed
