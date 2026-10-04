export function ReleaseFeatureArtwork({kind}: {kind: 'remote' | 'ocr' | 'prefetch'}) {
  return <svg viewBox="0 0 180 140" aria-hidden="true" focusable="false"
    fill="none" stroke="var(--comic-stroke)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'remote' && <>
      <path d="M97 61h53c10 0 17-7 17-16 0-8-6-14-14-15-3-11-13-17-24-14-9 2-15 9-16 18-10-3-20 4-20 14 0 5 2 10 4 13Z"
        fill="var(--comic-shadow-color)" stroke="none"/>
      <path d="M92 56h53c10 0 17-7 17-16 0-8-6-14-14-15-3-11-13-17-24-14-9 2-15 9-16 18-10-3-20 4-20 14 0 5 2 10 4 13Z"
        fill="var(--surface)"/>
      <path d="M112 29h21v24h-21c-4 0-4-6 0-6h21M113 29v18" fill="var(--icon-comic-blue)"/>
      <path d="M119 35h8M119 41h5" strokeWidth="2"/>
      <rect x="40" y="67" width="20" height="49" rx="3" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="64" y="53" width="25" height="63" rx="3" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="92" y="71" width="20" height="45" rx="3" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="35" y="63" width="20" height="49" rx="3" fill="var(--icon-comic-mint)"/>
      <rect x="59" y="49" width="25" height="63" rx="3" fill="var(--icon-comic-yellow)"/>
      <rect x="87" y="67" width="20" height="45" rx="3" fill="var(--icon-comic-purple)"/>
      <path d="M41 72h8M41 99h8M65 58h13M65 65h13M65 102h13M93 76h8M93 102h8" strokeWidth="2"/>
      <rect x="27" y="117" width="136" height="7" rx="3" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="22" y="112" width="136" height="7" rx="3" fill="var(--icon-comic-paper)"/>
      <path d="M34 119v9M146 119v9"/>
      <path d="M124 94c17-2 26-13 24-26M141 72l7-7 7 7" stroke="var(--icon-comic-blue)" strokeWidth="4"/>
      <path d="M127 67c-12 2-17 11-14 21M108 82l5 8 8-5" stroke="var(--icon-comic-pink)" strokeWidth="4"/>
      <g fill="var(--comic-stroke)" stroke="none" opacity=".2">
        <circle cx="23" cy="44" r="2"/><circle cx="31" cy="44" r="2"/>
        <circle cx="23" cy="52" r="2"/><circle cx="31" cy="52" r="2"/>
        <circle cx="159" cy="98" r="2"/><circle cx="167" cy="98" r="2"/>
      </g>
      <path d="m55 24 3 6m-16-1 6 4m107 89 5 2" strokeWidth="2"/>
    </>}
    {kind === 'ocr' && <>
      <rect x="46" y="24" width="94" height="105" rx="6" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="40" y="19" width="94" height="105" rx="6" fill="var(--icon-comic-paper)"/>
      <rect x="50" y="30" width="40" height="39" rx="2" fill="var(--icon-comic-purple)"/>
      <path d="m53 65 11-17 9 8 9-15 6 24" fill="var(--icon-comic-pink)"/>
      <circle cx="62" cy="39" r="3" fill="var(--icon-comic-yellow)" stroke="none"/>
      <path d="M105 32h16c5 0 8 3 8 7v10c0 4-3 7-8 7h-6l-8 7v-7h-2c-5 0-8-3-8-7V39c0-4 3-7 8-7Z"
        fill="var(--surface)" strokeWidth="2"/>
      <path d="M104 40h18M104 47h13M52 83h59M52 93h49M52 103h66M52 113h37" strokeWidth="2.5"/>
      <rect x="25" y="72" width="127" height="21" rx="3" fill="var(--icon-comic-mint)" stroke="none" opacity=".45"/>
      <path d="M26 82h126" stroke="var(--icon-comic-mint)" strokeWidth="4"/>
      <path d="M28 42V24h17M130 24h17v18M28 101v18h17M147 101v18h-17"
        stroke="var(--icon-comic-blue)" strokeWidth="4"/>
      <rect x="126" y="83" width="34" height="34" rx="6" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="121" y="78" width="34" height="34" rx="6" fill="var(--icon-comic-mint)"/>
      <path d="m129 90 6 6 12-12M129 104h18" strokeWidth="2.5"/>
      <g fill="var(--comic-stroke)" stroke="none" opacity=".2">
        <circle cx="16" cy="61" r="2"/><circle cx="24" cy="61" r="2"/>
        <circle cx="16" cy="69" r="2"/><circle cx="164" cy="42" r="2"/>
        <circle cx="164" cy="50" r="2"/><circle cx="156" cy="50" r="2"/>
      </g>
      <path d="m149 17 4-6m3 13 7-2m-145 96 6-3" strokeWidth="2"/>
    </>}
    {kind === 'prefetch' && <>
      <rect x="101" y="29" width="51" height="78" rx="5" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="96" y="24" width="51" height="78" rx="5" fill="var(--icon-comic-purple)"/>
      <path d="M105 37h33M105 45h25" strokeWidth="2"/>
      <rect x="116" y="47" width="49" height="79" rx="5" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="111" y="42" width="49" height="79" rx="5" fill="var(--icon-comic-paper)"/>
      <rect x="119" y="51" width="33" height="34" rx="2" fill="var(--icon-comic-mint)"/>
      <path d="m122 80 8-12 8 5 10-17M120 95h30M120 103h22M120 111h27" strokeWidth="2"/>
      <rect x="28" y="37" width="61" height="88" rx="5" fill="var(--comic-shadow-color)" stroke="none"/>
      <rect x="22" y="32" width="61" height="88" rx="5" fill="var(--surface)"/>
      <rect x="31" y="42" width="43" height="42" rx="2" fill="var(--icon-comic-blue)"/>
      <path d="m34 80 11-20 11 9 13-18" fill="var(--icon-comic-yellow)"/>
      <circle cx="63" cy="50" r="4" fill="var(--icon-comic-paper)" stroke="none"/>
      <path d="M32 94h40M32 102h28M32 110h35" strokeWidth="2.5"/>
      <circle cx="139" cy="26" r="11" fill="var(--icon-comic-mint)"/>
      <path d="m134 26 4 4 7-8" strokeWidth="2.5"/>
      <circle cx="158" cy="76" r="10" fill="var(--icon-comic-mint)"/>
      <path d="m153 76 4 4 7-8" strokeWidth="2.5"/>
      <path d="M82 102h20V91l17 18-17 18v-11H82Z" fill="var(--icon-comic-pink)"/>
      <path d="M84 19h11M82 25h6M12 68h6M12 76h6" strokeWidth="2"/>
      <g fill="var(--comic-stroke)" stroke="none" opacity=".2">
        <circle cx="44" cy="20" r="2"/><circle cx="52" cy="20" r="2"/><circle cx="60" cy="20" r="2"/>
        <circle cx="155" cy="132" r="2"/><circle cx="163" cy="132" r="2"/>
      </g>
    </>}
  </svg>;
}
