// Text preparation for the mission share card.
//
// Its own module so it can be tested without pulling in the image renderer.

import { cut } from "@/lib/text";

/**
 * A brief, made safe to draw on the OG card.
 *
 * A brief is free text, so it decides what glyphs end up in the image. Rendered
 * against the real card, accents, curly quotes, em dashes and CJK all come out
 * correctly — only pictographs and standalone symbols (a check mark, an emoji)
 * drop to a tofu box. So the strip is exactly those categories: a blanket ASCII
 * filter would have mangled every accented or non-Latin brief instead.
 *
 * The ellipsis is ASCII for the same reason.
 */
export function clip(s: string, max: number): string {
  const flat = s
    .replace(/[\p{Extended_Pictographic}\p{So}️‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // Stripping pictographs leaves plenty of multi-unit characters behind — a
  // non-BMP ideograph is a surrogate pair too — so the cut still has to be
  // character-aware, not code-unit-aware.
  //
  // `max` is the budget for the whole string, ellipsis included: this text is
  // laid out against a fixed card width, so the ellipsis has to come out of the
  // allowance rather than be added on top of it.
  if (cut(flat, max) === flat) return flat;
  return `${cut(flat, max - 3)}...`;
}
