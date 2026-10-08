# Extension third-party implementation notices

## MALSync — AniList protocol adaptation

- Project: [MALSync/MALSync](https://github.com/MALSync/MALSync), author identified by upstream package metadata as lolamtisch@gmail.com; credit to lolamtisch and MALSync contributors. The selected source files contain no additional copyright notice.
- Version: `0.12.5`, commit `f40f226b8bc52cdb42655f2a8448441b1b18b6f8`.
- License: `GPL-3.0-only`, as declared by upstream `package.json`. The complete upstream license is preserved in [the packaged license](public/licenses/malsync-GPL-3.0.txt); the GPL license text's sample “or later” language does not override the package declaration.
- Adapted destination: [src/tracking/anilist.ts](src/tracking/anilist.ts).
- Modified by Node Comics on 2026-10-07: retain `Media(id/idMal, type: MANGA)`, authenticated `mediaListEntry`, bearer GraphQL transport and `SaveMediaListEntry`; replace the application runtime with typed manga-only validation, anonymous search, identity-checked acknowledgements, minimal progress/status mutation, a 15-second timeout and shared response-header cooldown. Scores, dates, notes, repeat, volumes, OAuth client ID, token logging and the upstream UI/runtime are not copied.
- This adapts the protocol implementation, not MALSync's hosted mapping database or API. No permission for those services is implied.

| Original file at the fixed commit | SHA-256 of original Git blob |
| --- | --- |
| `src/_provider/AniList/single.ts` | `ccf692d2a7b5b7aeb8bc2a7835eb0596772d3e2378115304743bce0de437baa8` |
| `src/_provider/AniList/helper.ts` | `d50a4060c53763c748beceb0cc11c068b57b262a75e311d1c46f7589808deae5` |
| `LICENSE` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |

Binary distributions must retain the packaged notice/license and provide the corresponding Node Comics source, including modifications and build inputs, under the applicable GPL terms. Extension review-source packaging includes this notice, `src`, build configuration and the repository license; source publication must match the actual distributed revision.
