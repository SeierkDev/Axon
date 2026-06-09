import Link from "next/link";
import Image from "next/image";
import DocsSidebar from "@/components/DocsSidebar";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white text-[#0a0a0a]">
      {/* Docs header */}
      <header className="fixed top-0 left-0 right-0 z-50 h-14 border-b border-gray-200 bg-white/80 backdrop-blur-md">
        <div className="flex h-full items-center gap-6 px-6">
          <Link href="/" className="flex items-center">
            <Image src="/axon-logo.png" alt="Axon" width={48} height={48} className="h-12 w-12 object-contain" style={{ mixBlendMode: "multiply" }} />
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-500">Docs</span>
          <div className="ml-auto flex items-center gap-6">
            <Link
              href="https://github.com/Modulr402/Axon"
              className="text-sm text-gray-400 hover:text-gray-900 transition-colors"
            >
              GitHub
            </Link>
            <Link
              href="/"
              className="text-sm text-gray-400 hover:text-gray-900 transition-colors"
            >
              ← Back to site
            </Link>
          </div>
        </div>
      </header>

      {/* Sidebar */}
      <DocsSidebar />

      {/* Main content */}
      <main className="ml-64 mt-14 min-h-[calc(100vh-56px)]">
        <div className="max-w-3xl px-12 py-12">{children}</div>
      </main>
    </div>
  );
}
