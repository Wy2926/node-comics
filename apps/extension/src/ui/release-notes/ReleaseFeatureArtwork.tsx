import {useId} from 'react';

export function ReleaseFeatureArtwork() {
  const dots = useId();
  return <svg viewBox="0 0 400 280" aria-hidden="true" focusable="false" fill="none"
    stroke="var(--icon-comic-ink)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <defs><pattern id={dots} width="8" height="8" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="var(--icon-comic-ink)" stroke="none" opacity=".2"/>
    </pattern></defs>
    <circle cx="218" cy="140" r="114" fill="var(--icon-comic-yellow)" stroke="none"/>
    <circle cx="218" cy="140" r="114" fill={`url(#${dots})`} stroke="none"/>
    <ellipse cx="213" cy="152" rx="178" ry="92" transform="rotate(-22 213 152)" stroke="var(--accent-on)" strokeDasharray="3 8" opacity=".45"/>
    <g transform="rotate(12 322 92)">
      <rect x="288" y="40" width="65" height="91" rx="4" fill="var(--icon-comic-paper)"/>
      <path d="M299 54h41v32h-41Z" fill="var(--icon-comic-purple)"/>
      <path d="m300 80 11-16 10 12 10-8 9 12m-40 17h38m-38 10h25"/>
    </g>
    <g transform="rotate(-8 204 153)">
      <path d="M72 89q60-17 134 9 74-26 134-9v155q-60-17-134 9-74-26-134-9Z" fill="var(--icon-comic-ink)" opacity=".2" stroke="none"/>
      <path d="M64 81q63-19 140 8 77-27 140-8v155q-63-19-140 8-77-27-140-8Z" fill="var(--icon-comic-purple)"/>
      <path d="M69 74q61-16 135 9 74-25 135-9v155q-61-16-135 9-74-25-135-9Z" fill="var(--icon-comic-paper)"/>
      <path d="M204 83v155m-8-149v140" strokeWidth="1.5"/>
      <path d="M82 91q46-8 106 8v99q-53-15-106-8Z" fill="var(--icon-comic-blue)"/>
      <circle cx="104" cy="114" r="12" fill="var(--icon-comic-paper)" stroke="none"/>
      <path d="m84 169 14-11 15 7 15-15 14 14 14-7 30 22v17q-52-14-102-7Z" fill="var(--icon-comic-mint)" strokeWidth="1.5"/>
      <path d="m109 188 6-31q17-15 36-2l18 39" fill="var(--icon-comic-paper)"/>
      <path d="m122 153 18-5 17 15-19-2-11 11-13-10Z" fill="var(--icon-comic-yellow)"/>
      <path d="m141 160 21 5 21-7-6 15-20-2Z" fill="var(--icon-comic-yellow)"/>
      <path d="M119 130q0-22 18-22 21 0 21 22v9q-4 17-20 17-18-3-19-18Z" fill="var(--icon-comic-paper)"/>
      <path d="M118 133q-7-18 7-27 17-10 29 5 10 8 3 25l-7-18-9 10-4-13-8 16-11-3Z" fill="var(--icon-comic-ink)"/>
      <path d="M129 137h2m13 0h2m-12 9q5 4 9-1" strokeWidth="3"/>
      <path d="m82 203 48 2v15l-48-2Z" fill="var(--icon-comic-yellow)"/>
      <path d="m139 207 49 8v15l-49-8Z" fill="var(--icon-comic-mint)"/>
      <path d="M218 99q54-15 107-8v66q-53-7-107 8Z" fill="var(--icon-comic-purple)"/>
      <circle cx="297" cy="111" r="9" fill="var(--icon-comic-yellow)" strokeWidth="1.5"/>
      <path d="m233 151 18-23 14 15 21-18 26 25" strokeWidth="1.5"/>
      <path d="m257 113 10-10 10 10-10 19Z" fill="var(--icon-comic-paper)"/>
      <path d="m264 134 3 7 3-7" stroke="var(--icon-comic-yellow)" strokeWidth="3"/>
      <path d="M218 178q54-15 107-8v47q-53-7-107 8Z" fill="var(--icon-comic-mint)"/>
      <path d="M237 181h51q12 0 12 11t-12 11h-20l-13 10v-10h-18q-10 0-10-11t10-11Z" fill="var(--icon-comic-paper)" strokeWidth="1.5"/>
      <path d="M239 190h47m-47 6h33" strokeWidth="1.5"/>
    </g>
    <path d="m57 45 6 14 16 3-13 9-1 16-11-12-16 4 7-14-8-12 16 1Z" fill="var(--icon-comic-yellow)"/>
    <path d="m345 178 4 12 13 4-13 4-4 13-4-13-13-4 13-4Z" fill="var(--icon-comic-pink)"/>
    <path d="m159 26 4 9 9 3-9 3-4 10-3-10-10-3 10-3Z" fill="var(--icon-comic-paper)"/>
    <path d="m37 136-15-3m20 15-13 6m334-34 13-7m-17-7 5-12m-45 148 8 8m-19-6 1 12" stroke="var(--accent-on)" strokeWidth="3"/>
  </svg>;
}

export function ReleaseSpreadPreview() {
  return <svg viewBox="0 0 300 100" aria-hidden="true" focusable="false" fill="none"
    stroke="var(--comic-stroke)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M55 14h92v75H55Zm98 0h92v75h-92Z" fill="var(--surface)" transform="rotate(-3 150 50)"/>
    <path d="M64 22h73v36H64Z" fill="var(--icon-comic-blue)"/>
    <path d="m65 53 19-23 19 23 16-15 18 15M65 70h43m-43 8h61"/>
    <path d="M164 22h70v58h-70Z" fill="var(--icon-comic-mint)"/>
    <circle cx="185" cy="39" r="7" fill="var(--icon-comic-yellow)"/>
    <path d="m165 73 21-24 18 17 14-14 15 20"/>
    <path d="M36 51H15l8-8m-8 8 8 8m241-8h21l-8-8m8 8-8 8" stroke="var(--accent)" strokeWidth="3"/>
    <path d="M150 7v88" strokeDasharray="3 4" opacity=".35"/>
  </svg>;
}
