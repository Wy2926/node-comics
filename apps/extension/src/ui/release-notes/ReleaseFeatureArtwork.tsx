export type ReleaseFeatureKind = 'models' | 'subscription' | 'packs';

export function ReleaseFeatureArtwork({kind}: {kind: ReleaseFeatureKind}) {
  return <svg viewBox="0 0 180 140" aria-hidden="true" focusable="false"
    fill="none" stroke="var(--comic-stroke)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'models' && <>
      <path d="M75 70h24V30h25M99 70h25M99 70v40h25" stroke="var(--accent)"/>
      <rect x="20" y="39" width="57" height="73" rx="6" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="15" y="34" width="57" height="73" rx="6" fill="var(--surface)"/>
      <path d="M25 45h37v31H25Z" fill="var(--icon-comic-blue)"/>
      <path d="m29 70 9-14 9 9 11-16" stroke="var(--icon-comic-ink)"/>
      <path d="M26 86h34M26 95h23"/>
      <rect x="121" y="12" width="40" height="32" rx="7" fill="var(--icon-comic-purple)"/>
      <rect x="121" y="54" width="40" height="32" rx="7" fill="var(--icon-comic-mint)"/>
      <rect x="121" y="96" width="40" height="32" rx="7" fill="var(--icon-comic-yellow)"/>
      <g stroke="var(--icon-comic-ink)">
        <path d="m132 34 9-17 9 17m-14-6h10" strokeWidth="2"/>
        <path d="M131 64h20m-10-4v4m-5 0c0 8 6 13 14 15m-3-15c0 8-6 13-14 15" strokeWidth="2"/>
        <path d="m132 112 6 6 12-13"/>
      </g>
    </>}
    {kind === 'subscription' && <>
      <rect x="27" y="31" width="109" height="94" rx="8" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="22" y="26" width="109" height="94" rx="8" fill="var(--surface)"/>
      <path d="M22 54h109M45 17v20M108 17v20"/>
      <path d="m42 69 15 10 18-16 17 16 15-10-8 31H50Z" fill="var(--icon-comic-yellow)"/>
      <path d="M54 107h42"/>
      <path d="M134 45h16v43h15l-23 25-23-25h15Z" fill="var(--icon-comic-mint)"/>
      <path d="m145 21 6-7m7 16 9-2M9 81l-5 4" stroke="var(--accent)"/>
    </>}
    {kind === 'packs' && <>
      <path d="m38 46 52-24 54 24v67l-54 22-52-22Z" fill="var(--comic-shadow-color)" stroke="none"/>
      <path d="m33 41 52-24 54 24v67l-54 22-52-22Z" fill="var(--icon-comic-yellow)"/>
      <path d="m33 41 52 23 54-23M85 64v66"/>
      <path d="m60 29 53 23v25l-16 7V59L45 35" fill="var(--icon-comic-paper)"/>
      <path d="M45 79v19l20 9V88Z" fill="var(--surface)"/>
      <circle cx="139" cy="102" r="24" fill="var(--icon-comic-mint)"/>
      <path d="M127 102h24m-12-12v24" stroke="var(--icon-comic-ink)" strokeWidth="4"/>
      <path d="m145 22 6-6m5 18 9-1M17 57l-7-3" stroke="var(--accent)"/>
    </>}
  </svg>;
}
