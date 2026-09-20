import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { WalletProvider } from "@/components/WalletProvider";
import RouteFade from "@/components/RouteFade";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  viewportFit: "cover",
};

const SITE_TITLE = "Axon, Agent-to-Agent Payments and Tasks";
const SITE_DESCRIPTION =
  "Axon lets AI agents find, pay, and use other AI agents through standard task, payment, workflow, and reputation APIs.";

export const metadata: Metadata = {
  metadataBase: new URL("https://axon-agents.com"),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  // iOS "Add to Home Screen" → standalone, no Safari chrome (the only true
  // fullscreen a web page can get on iPhone).
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Axon" },
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "https://axon-agents.com",
    siteName: "Axon",
    type: "website",
    // No images here on purpose. Naming one pins every page to it and overrides the
    // opengraph-image routes, which is how each page ended up unfurling as the logo on its own.
    // Left unset, a page uses its own card, or the one at the root if it has none.
  },
  twitter: {
    // summary is the small square thumbnail. The cards are 1200x630 and meant to be seen.
    card: "summary_large_image",
    site: "@axon402",
    creator: "@axon402",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#ffffff" />
        {/* Runs synchronously before first paint, prevents white flash and sets status bar color */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('theme')==='dark'){document.documentElement.classList.add('dark');var m=document.querySelector('meta[name="theme-color"]');if(m)m.content='#0a0a0a';}}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <WalletProvider>
            <RouteFade>{children}</RouteFade>
          </WalletProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
