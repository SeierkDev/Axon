"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { WorldErrorBoundary } from "./ErrorBoundary";
import { isWebGLAvailable } from "./webgl";
import { connectPhantom } from "./wallet";

// Three.js / WebGL only runs in the browser — load the canvas pieces client-side
// only (no SSR) so there's no server-render of a GL context.
const Landing = dynamic(() => import("./Landing"), { ssr: false });
const World3D = dynamic(() => import("./World3D"), { ssr: false });

// Shown when the browser can't create a WebGL context (hardware acceleration off,
// GPU blocklisted, or a crashed GPU process). Without this the canvas just stays
// blank with an uncaught Three.js error.
function WebGLUnsupported() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#8eccf2] px-6">
      <div className="max-w-lg text-center bg-white/85 backdrop-blur rounded-2xl p-8 shadow-xl">
        <p className="text-xs tracking-[0.3em] text-emerald-600 font-mono mb-2">AXON WORLD</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-3">3D isn&apos;t available in this browser</h1>
        <p className="text-gray-600 mb-4">
          Axon World is a 3D experience and needs WebGL, which is currently disabled in your
          browser. To enter the world:
        </p>
        <ul className="text-left text-gray-700 text-sm space-y-2 mb-2">
          <li>1. Open <span className="font-mono bg-gray-100 px-1 rounded">chrome://settings/system</span> and turn on <b>“Use hardware acceleration when available”</b>, then relaunch.</li>
          <li>2. Still blank? Check <span className="font-mono bg-gray-100 px-1 rounded">chrome://gpu</span> — if WebGL shows “Disabled”, fully quit and reopen Chrome.</li>
          <li>3. Or open this page in another browser (Safari, Firefox, Edge).</li>
        </ul>
      </div>
    </div>
  );
}

// After clicking Enter, the visitor chooses how to join: connect a Phantom
// wallet (spawn in "your district") or explore as a guest. We never drop them
// straight in as a guest — they pick first.
function EntryChoice({ onGuest, onWallet }: { onGuest: () => void; onWallet: (addr: string) => void }) {
  const [state, setState] = useState<"idle" | "connecting" | "no-phantom" | "failed">("idle");
  const connect = async () => {
    setState("connecting");
    try {
      onWallet(await connectPhantom());
    } catch (e) {
      setState((e as Error).message === "PHANTOM_NOT_FOUND" ? "no-phantom" : "failed");
    }
  };
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gradient-to-b from-[#8eccf2] to-[#bfe0ee] px-6">
      <div className="w-full max-w-md text-center bg-white/90 backdrop-blur rounded-3xl p-8 shadow-2xl">
        <p className="text-xs tracking-[0.4em] text-emerald-600 font-mono mb-2">AXON · PHASE 10</p>
        <h1 className="text-3xl font-black text-gray-900 mb-2">Enter Axon World</h1>
        <p className="text-gray-600 mb-6">Connect your wallet to walk your own district, or explore as a guest.</p>
        <div className="space-y-3">
          <button
            onClick={connect}
            disabled={state === "connecting"}
            className="w-full rounded-full bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-lg font-bold py-3.5 shadow-lg hover:brightness-110 active:scale-[0.99] transition disabled:opacity-70"
          >
            {state === "connecting" ? "Connecting…" : "Log in with Phantom"}
          </button>
          <button
            onClick={onGuest}
            className="w-full rounded-full bg-white text-gray-800 text-lg font-semibold py-3.5 shadow border border-gray-200 hover:bg-gray-50 active:scale-[0.99] transition"
          >
            Play as guest
          </button>
        </div>
        {state === "no-phantom" && (
          <p className="mt-4 text-sm text-gray-600">
            Phantom not found.{" "}
            <a href="https://phantom.app/" target="_blank" rel="noreferrer" className="text-purple-600 underline">Install it</a>{" "}
            or play as guest.
          </p>
        )}
        {state === "failed" && <p className="mt-4 text-sm text-gray-600">Couldn&apos;t connect. Try again or play as guest.</p>}
      </div>
    </div>
  );
}

// Phase 10: the Axon Open World entry flow.
//   landing ("AXON WORLD" + Enter) → choose (Phantom / guest) → walk the island.
export default function WorldClient() {
  const [stage, setStage] = useState<"landing" | "choose" | "world">("landing");
  const [wallet, setWallet] = useState<string | null>(null);
  const [webgl, setWebgl] = useState<"checking" | "ok" | "none">("checking");

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setWebgl(isWebGLAvailable() ? "ok" : "none");
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (webgl === "checking") {
    return (
      <div className="fixed inset-0 bg-[#0b0f14] flex items-center justify-center">
        <p className="text-teal-400 font-mono tracking-[0.4em] text-sm">AXON WORLD</p>
      </div>
    );
  }
  if (webgl === "none") return <WebGLUnsupported />;

  const exit = () => { setWallet(null); setStage("landing"); };

  return (
    <WorldErrorBoundary>
      {stage === "world" ? (
        <World3D onExit={exit} initialWallet={wallet} />
      ) : stage === "choose" ? (
        <EntryChoice
          onGuest={() => setStage("world")}
          onWallet={(addr) => { setWallet(addr); setStage("world"); }}
        />
      ) : (
        <Landing onEnter={() => setStage("choose")} />
      )}
    </WorldErrorBoundary>
  );
}
