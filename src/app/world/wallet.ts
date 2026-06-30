// Phase 10 (10.4): minimal Phantom connect for Axon World. We only need the
// wallet's public key to resolve which agents belong to the visitor — no
// signing or transactions here. Mirrors the provider detection used by Axon
// Build's payment client.

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect?(): Promise<void>;
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  const provider = w.phantom?.solana ?? w.solana;
  return provider && provider.isPhantom ? provider : null;
}

// Connect and return the wallet address (base58). Throws "PHANTOM_NOT_FOUND"
// when the extension isn't present so the caller can prompt to install it.
//
// On MOBILE with no injected provider, deep-link into the Phantom app's
// in-app browser instead — it reopens this exact page with the provider
// injected, and connect works from there.
export async function connectPhantom(): Promise<string> {
  const provider = getPhantom();
  if (!provider) {
    const isTouch = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
    if (isTouch && typeof window !== "undefined") {
      const url = encodeURIComponent(window.location.href);
      const ref = encodeURIComponent(window.location.origin);
      window.location.href = `https://phantom.app/ul/browse/${url}?ref=${ref}`;
      // The page is navigating away — park the promise so no error UI flashes.
      return new Promise<string>(() => {});
    }
    throw new Error("PHANTOM_NOT_FOUND");
  }
  const { publicKey } = await provider.connect();
  return publicKey.toString();
}

export async function disconnectPhantom(): Promise<void> {
  try {
    await getPhantom()?.disconnect?.();
  } catch {
    /* ignore */
  }
}
