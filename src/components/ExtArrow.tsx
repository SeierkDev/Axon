// Inline arrow icons. The Unicode arrows ↗ / ↓ render as coloured emoji on iOS,
// so anywhere the UI shows an "opens externally" or "scroll down" cue we use these
// SVGs instead — identical on mobile and desktop, and they inherit text colour and
// size (em-based) so they sit inline with whatever text they follow.

export function ExtArrow({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block ml-0.5 h-[0.85em] w-[0.85em] align-[-0.05em] ${className}`}
    >
      <path d="M4 8 8 4M8 4H4.75M8 4V7.25" />
    </svg>
  );
}

export function DownArrow({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block ml-0.5 h-[0.85em] w-[0.85em] align-[-0.05em] ${className}`}
    >
      <path d="M6 3V9M6 9 3.5 6.5M6 9 8.5 6.5" />
    </svg>
  );
}
