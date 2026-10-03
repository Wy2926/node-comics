<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/extension/src/assets/brand/logo-horizontal-en-dark.webp">
  <img src="apps/extension/src/assets/brand/logo-horizontal-en-light.webp" width="460" alt="NodeLane Comics">
</picture>

[简体中文](README.md) | **English**

**Discover, organize, and read comics in your browser. Pick up where you left off.**

[![Website and downloads](https://img.shields.io/badge/Website-Download-1769B3?style=for-the-badge)](https://comics.nodelane.net/)
[![Developer documentation](https://img.shields.io/badge/Docs-Development-334155?style=for-the-badge)](#development)
[![Report an issue](https://img.shields.io/badge/Feedback-GitHub_Issues-6855A3?style=for-the-badge)](https://github.com/Wy2926/node-comics/issues)
[![Telegram community](https://img.shields.io/badge/Telegram-Join_community-229ED9?style=for-the-badge)](https://t.me/+pPyxB0Sxocw0MDc1)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square)](apps/extension/package.json)
[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square)](apps/extension/package.json)
[![WXT](https://img.shields.io/badge/Extension-WXT-475569?style=flat-square)](apps/extension/README.md)
[![FastAPI](https://img.shields.io/badge/API-FastAPI-009688?style=flat-square)](backend/README.md)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL-4169E1?style=flat-square)](backend/README.md)
[![License](https://img.shields.io/badge/License-GPL--3.0--only-64748B?style=flat-square)](LICENSE)

</div>

A comic reading and library extension for Chrome, Edge, and Firefox. Bring comics from local files, Google Drive, and supported websites into your library, find your next read, and cache chapters for offline reading.

When you need translation, enable standard translation or AI redraw and compare with the original. You can also connect to a self-hosted [manga-translator-ui](https://github.com/hgmzhn/manga-translator-ui) service.

## Features

- **Import and read**: Open CBZ / ZIP, CBR / RAR, PDF, and DRM-free MOBI / EPUB files, or import from Google Drive and supported websites.
- **Remote libraries**: Connect multiple OPDS catalogs and browse or read on demand, without importing the entire catalog. Supported resources can be saved offline.
- **Discover and search**: Browse trending, popular, top-rated, and new manga on AniList, then search supported websites by title, alternative title, or translated title.
- **Read offline**: Cache every directory and chapter of a website comic, select multiple source languages, track progress, pause and resume, and retry missing pages.
- **Read your way**: Choose continuous scrolling or single-page reading, reading direction, zoom, and a separate reading background.
- **Translate when needed**: Use standard translation or AI redraw, switch between originals and translations, compare them side by side, and restore your reading position.
- **Choose your translation service**: Use the official service or connect to a local manga-translator-ui instance. Local services do not require a NodeLane account.
- **Personalize the interface**: Choose from 16 interface languages, six accent colors, light and dark modes, and adjustable text sizes.

### My comics

Import, search, and manage comics, then pick up where you left off.

![Comic library and reading progress](docs/images/en/library.png)

<details>
<summary>View discovery, website search, offline caching, chapter navigation, and translation comparison</summary>

### Discover comics

Browse charts, read synopses, check ratings and alternative titles, then look for a website where you can read the comic.

![Comic discovery and title details](docs/images/en/discovery.png)

### Search comics

Search by title or alternative title, or translate the title first. Choose websites, review the results, and import a comic to start reading.

![Comic titles, website selection, and search results](docs/images/en/cross-language-search.png)

### Offline center

Manage caching tasks for website comics, track chapter progress and storage use, and pause or resume. Fully cached chapters are available offline.

![Offline caching task, chapter progress, and storage use](docs/images/en/offline-center.png)

### Reading and chapter navigation

Browse chapters in the reader, with language options, page counts, cache status, and reading progress.

![Reader with an expanded multilingual chapter list](docs/images/en/reader-directory.png)

### Compare originals and translations

Enable translation when you need it. View the original and translated pages side by side, or switch back to the original to keep reading.

![Original page and Chinese translation side by side](docs/images/en/translation-comparison.png)

</details>

These product screenshots were provided by a user. Comic content and cover artwork belong to their respective rights holders.

## Community and feedback

Join the [Telegram community](https://t.me/+pPyxB0Sxocw0MDc1) to discuss the extension and suggest features. To report a problem, open a [GitHub Issue](https://github.com/Wy2926/node-comics/issues) with your browser version, steps to reproduce, and relevant screenshots.

## Development

The module guides and technical documents linked below are currently in Chinese.

| Module | Purpose and entry point |
| --- | --- |
| [Browser extension](apps/extension/README.md) | Reader, library, website adapters, and translation UI |
| [Backend](backend/README.md) | API, persistent jobs, accounts, subscriptions, and administration |
| [Website](backend/website/README.md) | Product pages in 16 languages, image translation, guest trials, local history, downloads, and account pages |
| [Drive connection page](apps/drive-connect/README.md) | Google authorization and file selection |
| [Compute node](services/compute-node/README.md) | Install, run, and build the Windows bundle or Linux NVIDIA image |
| [Image engine](services/classic-engine/README.md) | Text detection, OCR, LaMa inpainting, and text rendering |

Each module README lists its requirements and run commands. See the [scripts guide](scripts/README.md) for validation tools.

## Development guidelines

| Topic | Documentation |
| --- | --- |
| Product and reading | [Product design](docs/PRODUCT_DESIGN.md), [Single-source reading](docs/SIMPLE_COMIC_READING_DESIGN.md), [Offline caching](docs/OFFLINE_CACHE_DESIGN.md) |
| Architecture and data | [System architecture](docs/ARCHITECTURE.md), [Sources and caching](docs/COMIC_SOURCE_ARCHITECTURE.md) |
| Translation and compute | [Translation contract](docs/READING_TRANSLATION_CONTRACT.md), [Compute protocol](docs/COMPUTE_PROTOCOL.md), [Cluster scheduling](docs/TRANSLATION_CLUSTER_DESIGN.md) |
| Websites and interface | [Website adapters](docs/SITE_ADAPTERS.md), [Comic discovery](docs/DISCOVERY.md), [Cross-language search](docs/COMIC_SEARCH_DESIGN.md), [Interface localization](docs/UI_INTERNATIONALIZATION.md), [Brand copy](docs/BRAND_AND_STORE_LISTING.md) |
| Accounts and operations | [Membership and quotas](docs/MEMBERSHIP_AND_QUOTAS.md), [Payments](docs/STRIPE_BILLING.md), [Admin console](docs/ADMIN_CONSOLE.md) |
| Deployment and maintenance | [Deployment](docs/DEPLOYMENT.md), [Backup and recovery](docs/OPERATIONS.md), [Code standards](docs/CODE_QUALITY.md), [API contract](contracts/README.md) |

See [AGENTS.md](AGENTS.md) for collaboration guidelines. Product rules are maintained in their topic documents rather than duplicated in this README.

## Licenses

Except for third-party content with explicit separate licensing, the NodeLane Comics project code is licensed under the **GNU General Public License v3.0 only (SPDX: `GPL-3.0-only`)**. See [LICENSE](LICENSE) for the full terms. This software comes without any warranty, as detailed in the license.

Third-party code, models, and fonts remain subject to their accompanying licenses, with their original copyright and license notices retained. See the image engine's [THIRD_PARTY.md](services/classic-engine/THIRD_PARTY.md) for provenance. The software license does not grant rights to comic content, covers, or user data.
