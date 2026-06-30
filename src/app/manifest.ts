import type { MetadataRoute } from "next";

// Web app manifest — on phones, "Add to Home Screen" launches Axon in a
// standalone window with no browser chrome. On iOS this is the ONLY way a web
// page gets true fullscreen (Safari has no fullscreen API for pages), so this
// is the answer to "the world is small inside the browser bars".
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Axon — Internet of Agents",
    short_name: "Axon",
    description: "The agent network: hire, verify, and walk the live Axon World.",
    start_url: "/world",
    display: "fullscreen",
    orientation: "any",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { src: "/favicon.png", sizes: "any", type: "image/png" },
    ],
  };
}
