export type ReleaseFeatureKind = 'enhancement' | 'directory' | 'documents';

export function ReleaseFeatureArtwork({kind}: {kind: ReleaseFeatureKind}) {
  return <svg viewBox="0 0 180 140" aria-hidden="true" focusable="false"
    fill="none" stroke="var(--comic-stroke)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'enhancement' && <>
      <rect x="15" y="36" width="64" height="83" rx="6" fill="var(--surface)"/>
      <path d="M25 51h13v13H25zm20 15h13v13H45zM25 83h13v13H25z" fill="var(--surface-soft)" strokeDasharray="3 4"/>
      <path d="M63 72h43m-11-11 11 11-11 11" stroke="var(--accent)"/>
      <rect x="108" y="31" width="60" height="91" rx="6" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="103" y="26" width="60" height="91" rx="6" fill="var(--icon-comic-blue)"/>
      <path d="m113 88 14-25 11 13 15-27v50h-40Z" fill="var(--surface)"/>
      <path d="m127 8 4 10 11 4-11 4-4 10-4-10-11-4 11-4Z" fill="var(--icon-comic-yellow)"/>
      <path d="m166 11-3 7m8 14 6 2M30 22l-6-6" stroke="var(--accent)"/>
    </>}
    {kind === 'directory' && <>
      <rect x="23" y="28" width="111" height="96" rx="8" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="18" y="23" width="111" height="96" rx="8" fill="var(--surface)"/>
      <path d="M18 48h111"/>
      <path d="M30 35h5m8 0h5m8 0h5" stroke="var(--accent)"/>
      <rect x="30" y="61" width="34" height="18" rx="5" fill="var(--icon-comic-mint)"/>
      <rect x="75" y="61" width="39" height="18" rx="5" fill="var(--icon-comic-blue)"/>
      <path d="M31 94h56m-56 11h40"/>
      <circle cx="132" cy="89" r="24" fill="var(--icon-comic-mint)"/>
      <path d="m150 107 16 17m-43-35 7 7 12-15" stroke="var(--icon-comic-ink)" strokeWidth="4"/>
    </>}
    {kind === 'documents' && <>
      <path d="M26 32h66l18 20v68H26Z" fill="var(--comic-shadow-color)" stroke="none"/>
      <path d="M21 27h66l18 20v68H21Z" fill="var(--surface)"/>
      <path d="M35 16h64l19 21v67H35Z" fill="var(--icon-comic-paper)"/>
      <path d="M99 16v21h19M48 52h46M48 65h31M48 78h20"/>
      <rect x="86" y="65" width="70" height="60" rx="7" fill="var(--icon-comic-yellow)"/>
      <path d="M119 66v34m-5-27h10m-10 9h10m-10 9h10" stroke="var(--icon-comic-ink)"/>
      <rect x="113" y="100" width="13" height="13" rx="3" fill="var(--surface)"/>
      <path d="m140 28 6-6m5 20 10-1M9 82l-5 4" stroke="var(--accent)"/>
    </>}
  </svg>;
}
