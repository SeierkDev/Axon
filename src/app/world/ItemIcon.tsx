// Drawn vector icons for every world item. Emoji were unreliable — 🫐 renders
// blank on systems missing the glyph, and several items shared the same emoji.
// These are self-contained SVGs: same look on every OS, one distinct icon per
// item, tinted to match the item's identity.

function Fish({ body, accent, slim = false }: { body: string; accent?: string; slim?: boolean }) {
  return (
    <g>
      <ellipse cx="10" cy="12" rx="7.2" ry={slim ? 3.4 : 4.6} fill={body} />
      <path d="M16 12 L22 8.2 L20.3 12 L22 15.8 Z" fill={body} />
      {accent && <path d="M6 9.6 Q10 7.6 14 9.6 L14 10.8 Q10 9 6 10.8 Z" fill={accent} />}
      <circle cx="6.6" cy="10.9" r="1" fill="#1f2937" />
      <path d={`M9 ${slim ? 14 : 15.4} Q10.6 ${slim ? 15.4 : 17} 12.4 ${slim ? 14 : 15.4}`} stroke={accent ?? "#00000022"} strokeWidth="1" fill="none" />
    </g>
  );
}

function Gear({ color, inner }: { color: string; inner: string }) {
  return (
    <g>
      {[0, 45, 90, 135].map((r) => (
        <rect key={r} x="10.6" y="2.6" width="2.8" height="18.8" rx="1" fill={color} transform={`rotate(${r} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="6.2" fill={color} />
      <circle cx="12" cy="12" r="2.6" fill={inner} />
    </g>
  );
}

function Sparkle({ x, y, s, color = "#fde68a" }: { x: number; y: number; s: number; color?: string }) {
  return <path d={`M${x} ${y - s} L${x + s * 0.3} ${y - s * 0.3} L${x + s} ${y} L${x + s * 0.3} ${y + s * 0.3} L${x} ${y + s} L${x - s * 0.3} ${y + s * 0.3} L${x - s} ${y} L${x - s * 0.3} ${y - s * 0.3} Z`} fill={color} />;
}

const ICONS: Record<string, React.ReactNode> = {
  minnow: <Fish body="#aab8c6" accent="#d7e0e8" slim />,
  perch: (
    <g>
      <Fish body="#7ba05a" accent="#a9c98a" />
      <path d="M8.5 8.2 L8.5 15.8 M11.5 7.8 L11.5 16.2" stroke="#55743c" strokeWidth="1.2" />
    </g>
  ),
  carp: <Fish body="#d9884a" accent="#f0b078" />,
  old_boot: (
    <g>
      <path d="M8 3.5 h6 v9 q0 1 1 1.4 l4 1.6 q2 .8 2 2.5 v1.5 q0 1 -1 1 H9 q-1 0 -1 -1 Z" fill="#8a6240" />
      <path d="M8 17 h13 v2 q0 1.5 -1 1.5 H9 q-1 0 -1 -1 Z" fill="#5e4128" />
      <rect x="8" y="3.5" width="6" height="2.2" fill="#6d4c31" />
      <path d="M10 7 h2 M10 9.5 h2" stroke="#5e4128" strokeWidth="1" />
    </g>
  ),
  bass: <Fish body="#3f7f8a" accent="#7fb6bf" />,
  catfish: (
    <g>
      <Fish body="#7d8a96" accent="#a8b4bf" />
      <path d="M4 10.5 L1 9 M4 12 L1 12 M4 13.5 L1 15" stroke="#5b6874" strokeWidth="1" />
    </g>
  ),
  pearl: (
    <g>
      <path d="M3 15 Q12 4 21 15 L18.5 17.5 Q12 12.5 5.5 17.5 Z" fill="#c9a27a" />
      <path d="M3 15 Q12 21 21 15 Q12 24 3 15 Z" fill="#a9825c" />
      <circle cx="12" cy="13.6" r="3.4" fill="#f5f0ea" />
      <circle cx="10.8" cy="12.5" r="1" fill="#ffffff" />
    </g>
  ),
  bottle_message: (
    <g transform="rotate(18 12 12)">
      <rect x="9" y="2.4" width="6" height="2.6" rx="0.8" fill="#8a6240" />
      <path d="M9.5 5 h5 v2 q3 1.6 3 4.6 V19 q0 2 -2 2 h-7 q-2 0 -2 -2 v-7.4 q0 -3 3 -4.6 Z" fill="#6fa8a0" opacity="0.85" />
      <rect x="9.6" y="11" width="4.8" height="6.4" rx="0.6" fill="#f2e8d0" transform="rotate(-8 12 14)" />
      <path d="M10.4 12.8 h3.4 M10.4 14.6 h3.4 M10.4 16.4 h2.2" stroke="#b09a6a" strokeWidth="0.8" transform="rotate(-8 12 14)" />
    </g>
  ),
  golden_koi: (
    <g>
      <Fish body="#e8b23a" accent="#f7d98a" />
      <circle cx="11.5" cy="11" r="1.6" fill="#f3f0e6" />
    </g>
  ),
  ancient_coin: (
    <g>
      <circle cx="12" cy="12" r="9" fill="#d9a94a" />
      <circle cx="12" cy="12" r="6.8" fill="none" stroke="#a87e2e" strokeWidth="1.2" />
      <rect x="9.8" y="9.8" width="4.4" height="4.4" fill="#a87e2e" />
      <rect x="10.9" y="10.9" width="2.2" height="2.2" fill="#d9a94a" />
    </g>
  ),
  teal_crystal: (
    <g>
      <path d="M12 2 L19 9 L12 22 L5 9 Z" fill="#2ea8a0" />
      <path d="M12 2 L19 9 L12 12.5 Z" fill="#54ccc4" />
      <path d="M12 2 L5 9 L12 12.5 Z" fill="#3fbcb4" />
      <path d="M5 9 L12 12.5 L12 22 Z" fill="#1e8781" />
    </g>
  ),
  golden_fish: (
    <g>
      <Fish body="#f0c246" accent="#fbe08a" />
      <Sparkle x={18.5} y={5} s={3} />
      <Sparkle x={4.5} y={18.5} s={2} />
    </g>
  ),
  axon_relic: <Gear color="#4a5560" inner="#1f262d" />,
  golden_egg: (
    <g>
      <path d="M12 2.6 C16.4 2.6 19 8.4 19 13 A7 7.6 0 0 1 5 13 C5 8.4 7.6 2.6 12 2.6 Z" fill="#e9b83e" />
      <path d="M9 6.4 Q10.4 4.6 12 4.4" stroke="#f8dd8c" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </g>
  ),
  ring_trophy: (
    <g>
      <path d="M7 3 h10 v6 a5 5 0 0 1 -10 0 Z" fill="#e2ae3c" />
      <path d="M7 4.4 H3.6 q0 5 4 5.8 M17 4.4 h3.4 q0 5 -4 5.8" stroke="#e2ae3c" strokeWidth="1.8" fill="none" />
      <rect x="10.6" y="13.4" width="2.8" height="3.6" fill="#c2922e" />
      <rect x="7.6" y="17" width="8.8" height="2.6" rx="0.8" fill="#8a6240" />
      <path d="M10 5.4 L12 7.4 L14 5.4" stroke="#f7d98a" strokeWidth="1.2" fill="none" />
    </g>
  ),
  apple: (
    <g>
      <path d="M12 7.4 C8 4.4 3.6 7.4 4.4 12.4 C5 16.6 8 21 10.4 21 q1.6 -.8 3.2 0 C16 21 19 16.6 19.6 12.4 C20.4 7.4 16 4.4 12 7.4 Z" fill="#d94f3e" />
      <path d="M12 7 Q11.8 4.4 13.4 3" stroke="#6d4c31" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M13.6 5.2 Q16.6 3.4 17.8 5.4 Q15.8 7.2 13.6 5.2 Z" fill="#6a9a4a" />
      <path d="M7.4 10.2 Q7 12.6 8 14.6" stroke="#f0937f" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </g>
  ),
  berries: (
    <g>
      <circle cx="8.2" cy="14.6" r="4.6" fill="#4a5fb0" />
      <circle cx="15.8" cy="14.6" r="4.6" fill="#5a71c9" />
      <circle cx="12" cy="8.8" r="4.6" fill="#3d4f96" />
      <path d="M12 4.2 Q12.6 2.4 14.4 2" stroke="#5b7a3c" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="10.8" cy="7.8" r="0.9" fill="#8ea0e0" />
      <circle cx="7.2" cy="13.4" r="0.9" fill="#8ea0e0" />
    </g>
  ),
  golden_berry: (
    <g>
      <circle cx="12" cy="13" r="6.4" fill="#eec244" />
      <circle cx="10.2" cy="11" r="1.4" fill="#fbe9a8" />
      <path d="M12 6.6 Q12.6 4.6 14.6 4.2" stroke="#6a9a4a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <Sparkle x={19} y={6.5} s={2.4} />
      <Sparkle x={4.6} y={17.5} s={1.8} />
    </g>
  ),
  rusty_gear: <Gear color="#9a6b3f" inner="#5e4128" />,
  gift_chest: (
    <g>
      <path d="M4 10 q0 -4 8 -4 t8 4 v2 H4 Z" fill="#8a6240" />
      <rect x="4" y="12" width="16" height="8" rx="1" fill="#6d4c31" />
      <rect x="10.6" y="8" width="2.8" height="12" fill="#d9a94a" />
      <rect x="10" y="11" width="4" height="3.4" rx="0.7" fill="#e9c05e" />
    </g>
  ),
};

export function ItemIcon({ id, size = 20, className }: { id: string; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
      aria-hidden
    >
      {ICONS[id] ?? <circle cx="12" cy="12" r="8" fill="#9ca3af" />}
    </svg>
  );
}
