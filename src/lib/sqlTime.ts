// Comparing a stored timestamp against a moving cutoff, without the formats disagreeing.
//
// Timestamps in this database are written by JavaScript, so they are ISO-8601 with a T and a Z:
//   2026-09-18T15:19:01.626Z
// SQLite's own datetime() returns a different shape, with a space and no zone:
//   2026-09-18 17:19:01
//
// Both are strings, and SQLite compares them as strings. On different dates that happens to work,
// because the date decides it. On the SAME date it silently inverts: at the tenth character the
// comparison is "T" against " ", and "T" is the larger byte, so EVERY stored time on the cutoff's
// own date compares as later than the cutoff, however early in the day it actually was.
//
// So `completed_at >= datetime('now', '-24 hours')` quietly sweeps in a whole extra day. It never
// errors and the result looks plausible, which is why it survived: a success rate measured that
// way pulled in a day of a provider outage it was supposed to exclude, and a spend window counted
// spending that had already aged out of it.
//
// strftime with an explicit format gives the cutoff the same shape as the stored value, so the
// string comparison means what it reads as. It stays a plain comparison against the column, so
// an index on that column is still usable.

/** A cutoff N hours in the past, in the same ISO-8601 shape the app stores. */
export const isoHoursAgo = (hours: number): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(hours)} hours')`;

/** A cutoff N days in the past, same shape. */
export const isoDaysAgo = (days: number): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Number(days)} days')`;

/**
 * The same cutoff where the number of hours is a bound parameter rather than a literal.
 * The format string is fixed; only the offset comes from the caller.
 */
export const ISO_HOURS_AGO_PARAM = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')`;
