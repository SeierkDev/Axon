"use client";
// The wallet, and the sign-in built on top of it.
//
// Connecting only proves which address the browser controls. Signing in turns that proof into an API
// key: the server hands out a challenge, the wallet signs it, and the server returns the key that
// every authenticated call carries. The key is what the rest of the app already speaks, so nothing
// downstream has to know a wallet was involved.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  CHAIN_ID,
  CHAIN_ID_HEX,
  CHAIN_PARAMS,
  asHexChain,
  isPhone,
  mayRestoreWallet,
  metaMaskDeepLink,
  provider,
  readableWalletError,
  signMessage,
} from "@/lib/chain";

interface WalletCtx {
  address: string | null;
  chainId: number | null;
  onRightChain: boolean;
  /** true while a request is in front of the user, so a button can say so instead of looking dead */
  busy: boolean;
  /** null unless the last attempt failed, in which case it is something a person can act on */
  error: string | null;
  /** the API key from the last successful sign-in, if there was one */
  apiKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  /** connect if needed, then sign the challenge and return the issued key */
  signIn: () => Promise<SignInResult | null>;
  /** connect if needed, then sign an arbitrary message. Returns the 0x signature, or null. */
  sign: (message: string) => Promise<{ address: string; signature: string } | null>;
}

export interface SignInResult {
  apiKey: string;
  keyId: string;
  walletAddress: string;
}

const Ctx = createContext<WalletCtx | null>(null);

/** Read at the moment of the tap rather than at render, so it is never baked into the server's HTML. */
const onAPhone = () =>
  typeof window !== "undefined" &&
  isPhone(navigator.userAgent, window.matchMedia?.("(pointer: coarse)").matches ?? false);

// Whether this browser has ever connected here. The flag is the permission to speak to the wallet on
// a page load at all; it says nothing about who, and every access is wrapped because storage throws
// in a private window.
const CONNECTED_KEY = "axon.connected";
const API_KEY_KEY = "axon.apiKey";

const readFlag = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeFlag = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a browser that refuses storage simply asks for the click every time */
  }
};
const clearFlag = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to forget */
  }
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);

  // Pick up a wallet that is already authorised, without ever opening it.
  //
  // eth_accounts asks nobody anything by the specification: it reports what has already been
  // granted. What the specification does not cover is a LOCKED wallet. MetaMask treats any call from
  // an origin it has permissions for as a reason to open and ask for the password, so a visitor who
  // connected once would meet the extension on every later arrival, before touching anything.
  //
  // So nothing is said to the wallet on a page load the visitor did not ask for: the restore runs
  // only if this browser has connected here before, and only if the wallet says it is unlocked.
  useEffect(() => {
    const p = provider();
    if (!p) return;
    let alive = true;

    void (async () => {
      if (readFlag(CONNECTED_KEY) !== "1") return;
      let unlocked: boolean | undefined;
      try {
        unlocked = await p._metamask?.isUnlocked?.();
      } catch {
        /* not MetaMask, or it will not say; eth_accounts is silent on every other wallet */
      }
      if (!mayRestoreWallet(true, unlocked)) return;
      try {
        const accounts = (await p.request({ method: "eth_accounts" })) as string[];
        if (!accounts?.length) {
          clearFlag(CONNECTED_KEY); // permission revoked in the wallet; stop trying on every load
          clearFlag(API_KEY_KEY);
          return;
        }
        if (!alive) return;
        setAddress(accounts[0]);
        setApiKey(readFlag(API_KEY_KEY));
        const id = asHexChain(await p.request({ method: "eth_chainId" }));
        if (alive) setChainId(id);
      } catch {
        /* a wallet that will not answer a read is a wallet we simply do not use */
      }
    })();

    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      setAddress(accounts?.length ? accounts[0] : null);
      setError(null);
      // The key belongs to the address that signed for it, so any account change drops it. Keeping
      // it would leave the dashboard showing one account's agents while the header names another.
      setApiKey(null);
      clearFlag(API_KEY_KEY);
    };
    const onChain = (...args: unknown[]) => setChainId(asHexChain(args[0]));
    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      alive = false;
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const switchChain = useCallback(async () => {
    const p = provider();
    if (!p) return;
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
    } catch (e) {
      // 4902 is "I have never heard of this chain", the normal case for a chain this new, so offer it
      if ((e as { code?: number }).code === 4902) {
        await p.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS] });
      } else throw e;
    }
  }, []);

  const connect = useCallback(async (): Promise<void> => {
    const p = provider();
    if (!p) {
      // A phone has no extension to find, and almost certainly does have the wallet installed
      // already, just not in this browser. Sending it to MetaMask's own browser is the only way in,
      // and it is what the button said it would do. An error string the header never renders would
      // make the tap look broken rather than unsupported.
      if (onAPhone()) {
        window.location.href = metaMaskDeepLink(window.location.href);
        return;
      }
      setError("No wallet found in this browser. MetaMask and Rabby both work.");
      window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      setAddress(accounts?.[0] ?? null);
      // only now may a later page load speak to the wallet on its own
      if (accounts?.[0]) writeFlag(CONNECTED_KEY, "1");
      const id = asHexChain(await p.request({ method: "eth_chainId" }));
      setChainId(id);
      if (id !== CHAIN_ID) {
        try {
          await switchChain();
          setChainId(asHexChain(await p.request({ method: "eth_chainId" })));
        } catch (e) {
          // being on the wrong chain is not a failed connection: the address is still readable
          setError(readableWalletError(e));
        }
      }
    } catch (e) {
      setError(readableWalletError(e));
    } finally {
      setBusy(false);
    }
  }, [switchChain]);

  const signIn = useCallback(async (): Promise<SignInResult | null> => {
    const p = provider();
    if (!p) {
      await connect(); // handles the phone deep link and the no-wallet case
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      // Ask the wallet rather than trusting component state: this is the address the signature will
      // actually come from, and eth_requestAccounts prompts nobody who has already connected.
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      const walletAddress = accounts?.[0];
      if (!walletAddress) {
        setError("No account was shared by the wallet.");
        return null;
      }
      setAddress(walletAddress);
      writeFlag(CONNECTED_KEY, "1");

      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      const challengeBody = (await challengeRes.json().catch(() => ({}))) as {
        challenge?: string;
        error?: string;
      };
      if (!challengeRes.ok || !challengeBody.challenge) {
        setError(challengeBody.error ?? "Could not start sign-in.");
        return null;
      }

      // The challenge is the exact text the wallet shows and the server checks. It is signed
      // verbatim; changing so much as a newline here would fail verification.
      const signature = await signMessage(p, walletAddress, challengeBody.challenge);

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress, challenge: challengeBody.challenge, signature }),
      });
      const verifyBody = (await verifyRes.json().catch(() => ({}))) as {
        apiKey?: string;
        keyId?: string;
        walletAddress?: string;
        error?: string;
      };
      if (!verifyRes.ok || !verifyBody.apiKey) {
        setError(verifyBody.error ?? "Sign-in was refused.");
        return null;
      }

      setApiKey(verifyBody.apiKey);
      writeFlag(API_KEY_KEY, verifyBody.apiKey);
      return {
        apiKey: verifyBody.apiKey,
        keyId: verifyBody.keyId ?? "",
        walletAddress: verifyBody.walletAddress ?? walletAddress.toLowerCase(),
      };
    } catch (e) {
      setError(readableWalletError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [connect]);

  /**
   * Sign a message the server will check. Everything that used to ask a Solana wallet for a
   * base64 ed25519 signature comes through here instead, because the server verifies by recovering
   * the signer from an EIP-191 signature and nothing else will recover.
   */
  const sign = useCallback(async (message: string): Promise<{ address: string; signature: string } | null> => {
    const p = provider();
    if (!p) {
      await connect(); // the phone deep link and the no-wallet case both live in connect
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      const walletAddress = accounts?.[0];
      if (!walletAddress) {
        setError("No account was shared by the wallet.");
        return null;
      }
      setAddress(walletAddress);
      writeFlag(CONNECTED_KEY, "1");
      const signature = await signMessage(p, walletAddress, message);
      return { address: walletAddress.toLowerCase(), signature };
    } catch (e) {
      setError(readableWalletError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [connect]);

  // A wallet cannot be told to forget a site, so this clears what this page knows rather than
  // pretending otherwise. Saying "disconnect" and leaving the address on screen would be the lie.
  const disconnect = useCallback(() => {
    setAddress(null);
    setApiKey(null);
    setError(null);
    clearFlag(CONNECTED_KEY);
    clearFlag(API_KEY_KEY);
  }, []);

  return (
    <Ctx.Provider
      value={{
        address,
        chainId,
        onRightChain: chainId === CHAIN_ID,
        busy,
        error,
        apiKey,
        connect,
        disconnect,
        switchChain,
        signIn,
        sign,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet must be used inside <WalletProvider>");
  return c;
}
