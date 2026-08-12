// Cutting user-written text to length, without cutting a character in half.

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * The first `max` units of `s`, where a unit is a character as a person sees it.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it will cut an emoji or
 * a non-BMP ideograph down the middle and leave a lone surrogate — which is not
 * valid text. Measured, that reached the wire: a brief whose emoji straddled
 * character 90 served an `og:title` containing a mangled half-character, in the
 * preview every shared link shows. SQLite scrubs it on write, so stored briefs
 * came back as a replacement character instead — quieter, equally wrong.
 *
 * Segmenting by grapheme rather than by code point also keeps clusters whole, so
 * a family emoji or a flag doesn't come apart into its component pieces.
 */
export function cut(s: string, max: number): string {
  if (max <= 0) return "";
  // Fast path: no surrogate at all means code units and characters agree.
  if (s.length <= max && !/[\uD800-\uDFFF]/.test(s)) return s;

  const units: string[] = segmenter
    ? Array.from(segmenter.segment(s), (seg) => seg.segment)
    : Array.from(s); // code points, still never splits a surrogate pair
  if (units.length <= max) return s;
  return units.slice(0, max).join("");
}

/** `cut`, with an ellipsis when something was actually removed. */
export function cutWithEllipsis(s: string, max: number, ellipsis = "…"): string {
  const out = cut(s, max);
  return out === s ? s : out + ellipsis;
}
