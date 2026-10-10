import type { ExperienceId } from './experiences';

/**
 * A small illustration for each kind of event, drawn from the console's own tile colours.
 *
 * ── WHY DRAWINGS AND NOT PHOTOS ────────────────────────────────────────────────────
 * The first screen needs real visual identity: seven grey icons in seven white boxes read as a
 * settings page, not as the start of something. Stock concert and cinema photos would look
 * richer, but they would sit next to the organizer's own events and read as somebody's real
 * event (the design direction forbids exactly that). These are plainly drawings: flat shapes in
 * `currentColor` at a few opacities, on the card's pastel tile, so they follow light and dark
 * mode with the tile tokens and need no image files.
 *
 * Decorative only. The card's label and description say what each choice is.
 */
export function ExperienceArt({ id, className = '' }: { id: ExperienceId; className?: string }) {
  return (
    <svg
      viewBox="0 0 240 120"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ART[id]}
    </svg>
  );
}

const C = 'currentColor';

const ART: Record<ExperienceId, JSX.Element> = {
  // Light beams over a stage, a crowd in front of it, two notes in the air.
  concert: (
    <g fill={C}>
      <path d="M70 0 L40 120 L100 120 Z" fillOpacity="0.10" />
      <path d="M120 0 L95 120 L145 120 Z" fillOpacity="0.14" />
      <path d="M170 0 L140 120 L200 120 Z" fillOpacity="0.10" />
      <circle cx="70" cy="4" r="6" fillOpacity="0.55" />
      <circle cx="120" cy="4" r="6" fillOpacity="0.7" />
      <circle cx="170" cy="4" r="6" fillOpacity="0.55" />
      <rect x="30" y="78" width="180" height="8" rx="2" fillOpacity="0.35" />
      <path
        d="M0 120 V104 a10 10 0 0 1 20 0 a9 9 0 0 1 18 0 a11 11 0 0 1 22 0 a9 9 0 0 1 18 0 a10 10 0 0 1 20 0 a9 9 0 0 1 18 0 a11 11 0 0 1 22 0 a9 9 0 0 1 18 0 a10 10 0 0 1 20 0 a9 9 0 0 1 18 0 a11 11 0 0 1 22 0 a9 9 0 0 1 18 0 a10 10 0 0 1 20 0 V120 Z"
        fillOpacity="0.55"
      />
      <path
        d="M186 30 v20 a5 5 0 1 1 -3 -4.6 V34 l14 -4 v16 a5 5 0 1 1 -3 -4.6 V33 Z"
        fillOpacity="0.8"
      />
      <path d="M48 36 v16 a4.5 4.5 0 1 1 -3 -4.2 V36 Z M45 36 h10 v4 h-7 Z" fillOpacity="0.6" />
    </g>
  ),
  // A screen with a soft glow, rows of seats facing it, a strip of film.
  movie: (
    <g fill={C}>
      <rect x="54" y="14" width="132" height="54" rx="4" fillOpacity="0.22" />
      <rect x="62" y="21" width="116" height="40" rx="2" fillOpacity="0.38" />
      <path d="M62 61 L20 120 H220 L178 61 Z" fillOpacity="0.08" />
      {[0, 1, 2].map((row) => (
        <g key={row} fillOpacity={0.45 + row * 0.15}>
          {Array.from({ length: 9 + row * 2 }).map((_, i, all) => {
            const w = 12 + row * 2;
            const gap = 4;
            const total = all.length * w + (all.length - 1) * gap;
            return (
              <rect
                key={i}
                x={120 - total / 2 + i * (w + gap)}
                y={78 + row * 14}
                width={w}
                height={9}
                rx={3}
              />
            );
          })}
        </g>
      ))}
      <g fillOpacity="0.55">
        <rect x="6" y="10" width="22" height="100" rx="3" />
      </g>
      <g fill="hsl(var(--background-surface))" fillOpacity="0.85">
        {[16, 30, 44, 58, 72, 86, 100].map((y) => (
          <rect key={y} x="10" y={y - 2} width="5" height="5" rx="1" />
        ))}
      </g>
    </g>
  ),
  // Curtains drawn back from a lit stage, and a microphone in the spotlight.
  stage: (
    <g fill={C}>
      <ellipse cx="120" cy="104" rx="56" ry="12" fillOpacity="0.18" />
      <path d="M96 0 L84 104 H156 L144 0 Z" fillOpacity="0.08" />
      <rect x="0" y="0" width="240" height="12" fillOpacity="0.4" />
      <path d="M0 12 H66 C60 50 50 86 56 120 H0 Z" fillOpacity="0.22" />
      <path d="M240 12 H174 C180 50 190 86 184 120 H240 Z" fillOpacity="0.22" />
      <path d="M0 12 H36 C32 60 28 90 30 120 H0 Z" fillOpacity="0.22" />
      <path d="M240 12 H204 C208 60 212 90 210 120 H240 Z" fillOpacity="0.22" />
      <rect x="118" y="58" width="4" height="44" rx="2" fillOpacity="0.75" />
      <rect
        x="109"
        y="44"
        width="10"
        height="20"
        rx="5"
        fillOpacity="0.85"
        transform="rotate(-18 114 54)"
      />
      <rect x="108" y="100" width="24" height="4" rx="2" fillOpacity="0.75" />
    </g>
  ),
  // A slide with a rising chart, a lectern, and an audience.
  conference: (
    <g fill={C}>
      <rect x="44" y="12" width="120" height="68" rx="5" fillOpacity="0.22" />
      <rect x="62" y="54" width="12" height="16" rx="2" fillOpacity="0.55" />
      <rect x="80" y="44" width="12" height="26" rx="2" fillOpacity="0.65" />
      <rect x="98" y="34" width="12" height="36" rx="2" fillOpacity="0.75" />
      <rect x="116" y="24" width="12" height="46" rx="2" fillOpacity="0.9" />
      <rect x="136" y="24" width="18" height="4" rx="2" fillOpacity="0.45" />
      <rect x="136" y="32" width="14" height="4" rx="2" fillOpacity="0.3" />
      <path d="M176 60 H206 L202 104 H180 Z" fillOpacity="0.55" />
      <circle cx="191" cy="48" r="8" fillOpacity="0.7" />
      {[30, 62, 94, 126, 158].map((x, i) => (
        <g key={x} fillOpacity={0.35 + (i % 2) * 0.15}>
          <circle cx={x} cy="98" r="8" />
          <path d={`M${x - 13} 120 a13 13 0 0 1 26 0 Z`} />
        </g>
      ))}
    </g>
  ),
  // A pitch from above: halfway line, centre circle, a ball, goal mouths.
  sports: (
    <g fill="none" stroke={C}>
      <rect x="16" y="12" width="208" height="96" rx="6" strokeOpacity="0.45" strokeWidth="3" />
      <line x1="120" y1="12" x2="120" y2="108" strokeOpacity="0.45" strokeWidth="3" />
      <circle cx="120" cy="60" r="20" strokeOpacity="0.45" strokeWidth="3" />
      <rect x="16" y="38" width="26" height="44" strokeOpacity="0.45" strokeWidth="3" />
      <rect x="198" y="38" width="26" height="44" strokeOpacity="0.45" strokeWidth="3" />
      <rect x="0" y="0" width="240" height="120" fill={C} fillOpacity="0.06" stroke="none" />
      <circle cx="160" cy="74" r="10" fill={C} fillOpacity="0.85" stroke="none" />
      <path
        d="M160 68 l5 3.5 -2 6 h-6 l-2 -6 Z"
        fill="hsl(var(--background-surface))"
        fillOpacity="0.9"
        stroke="none"
      />
      <path d="M138 80 q10 6 12 -2" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="3 4" />
    </g>
  ),
  // A gallery wall: frames of different sizes, a spotlight, a bench.
  exhibition: (
    <g fill={C}>
      <rect x="0" y="96" width="240" height="24" fillOpacity="0.12" />
      <rect x="26" y="22" width="56" height="64" rx="3" fillOpacity="0.55" />
      <rect x="32" y="28" width="44" height="52" rx="2" fillOpacity="0.3" />
      <path d="M36 74 l14 -18 10 12 6 -6 10 12 Z" fillOpacity="0.6" />
      <rect x="96" y="14" width="64" height="46" rx="3" fillOpacity="0.7" />
      <rect x="102" y="20" width="52" height="34" rx="2" fillOpacity="0.35" />
      <circle cx="140" cy="30" r="6" fillOpacity="0.7" />
      <rect x="174" y="30" width="42" height="42" rx="3" fillOpacity="0.45" />
      <circle cx="195" cy="51" r="12" fillOpacity="0.45" />
      <rect x="96" y="68" width="30" height="4" rx="2" fillOpacity="0.35" />
      <rect x="100" y="98" width="56" height="7" rx="3" fillOpacity="0.6" />
      <rect x="106" y="105" width="4" height="10" fillOpacity="0.6" />
      <rect x="146" y="105" width="4" height="10" fillOpacity="0.6" />
    </g>
  ),
  // Bunting over a crowd of friends and a tree.
  community: (
    <g fill={C}>
      <path d="M0 14 Q120 44 240 14" fill="none" stroke={C} strokeOpacity="0.45" strokeWidth="2" />
      {[16, 44, 72, 100, 128, 156, 184, 212].map((x, i) => {
        const y = 14 + 30 * (1 - Math.pow((x - 120) / 120, 2)) * 0.98;
        return (
          <path
            key={x}
            d={`M${x - 8} ${y - 2} L${x + 8} ${y - 2} L${x} ${y + 14} Z`}
            fillOpacity={i % 2 ? 0.45 : 0.75}
          />
        );
      })}
      <circle cx="204" cy="70" r="20" fillOpacity="0.3" />
      <rect x="201" y="84" width="6" height="30" rx="2" fillOpacity="0.45" />
      {[
        [44, 0.7, 11],
        [78, 0.5, 9],
        [110, 0.85, 12],
        [144, 0.55, 9],
        [174, 0.7, 10],
      ].map(([x, o, r]) => (
        <g key={x} fillOpacity={o}>
          <circle cx={x} cy={120 - r * 3.6} r={r} />
          <path d={`M${x - r * 1.6} 120 a${r * 1.6} ${r * 1.6} 0 0 1 ${r * 3.2} 0 Z`} />
        </g>
      ))}
    </g>
  ),
};
