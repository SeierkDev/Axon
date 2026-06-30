"use client";

import { Component, type ReactNode } from "react";

// Surfaces any render-time error from the 3D tree ON SCREEN (instead of a silent
// blank canvas), so failures are diagnosable without the dev console.
export class WorldErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? `${err.message}` : String(err) };
  }

  componentDidCatch(err: unknown) {
    // Also log for anyone with the console open.
    console.error("[world] render error:", err);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 flex items-center justify-center bg-[#1e293b] text-white p-8">
          <div className="max-w-lg text-center">
            <p className="text-sm tracking-widest text-red-400 font-mono mb-2">AXON WORLD — RENDER ERROR</p>
            <pre className="text-xs text-left bg-black/40 p-4 rounded-lg overflow-auto whitespace-pre-wrap">
              {this.state.error}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
