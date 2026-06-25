import type { ReactNode } from "react";

// The playground page is a Client Component and can't export metadata itself,
// so the segment title lives here.
export const metadata = { title: "API Playground — Axon Docs" };

export default function PlaygroundLayout({ children }: { children: ReactNode }) {
  return children;
}
