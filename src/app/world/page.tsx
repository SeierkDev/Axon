import type { Metadata } from "next";
import WorldClient from "./WorldClient";

// Hidden during the Phase 10 build — not linked anywhere and kept out of search
// indexes until the Open World v1 (10.6) is complete and matches the announcement.
export const metadata: Metadata = {
  title: "Axon Open World",
  robots: { index: false, follow: false },
};

export default function WorldPage() {
  return <WorldClient />;
}
