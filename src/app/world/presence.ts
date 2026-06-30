"use client";

// Phase 10 (10.6): client side of Axon World realtime presence.
//
// Connects to the presence WebSocket (NEXT_PUBLIC_PRESENCE_URL), announces this
// visitor, streams their pose, and tracks everyone else's latest pose for
// interpolated rendering. Degrades gracefully: if the URL is unset or the socket
// can't connect, the hook stays quiet and the world runs solo.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarLook } from "./World3D";

export interface PeerPose {
  x: number;
  z: number;
  ry: number;
  st: string;
}
export interface PeerMeta {
  id: string;
  name: string;
  look: AvatarLook;
}

type SelfMeta = { name: string; look: AvatarLook };

interface WelcomeMsg { t: "welcome"; id: string; peers: (PeerMeta & PeerPose)[] }
interface JoinMsg { t: "join"; peer: PeerMeta & PeerPose }
interface PoseMsg { t: "pose"; id: string; x: number; z: number; ry: number; st: string }
interface UpdateMsg { t: "update"; id: string; name: string; look: AvatarLook }
interface LeaveMsg { t: "leave"; id: string }
interface CountMsg { t: "count"; n: number }
interface ChatMsg { t: "chat"; id: string; name: string; text: string }
interface EmoteMsg { t: "emote"; id: string; name: string; e: string }
interface GiftMsg { t: "gift"; from: string; name: string; item: string }
type ServerMsg = WelcomeMsg | JoinMsg | PoseMsg | UpdateMsg | LeaveMsg | CountMsg | ChatMsg | EmoteMsg | GiftMsg;

export interface ChatLine { key: number; id: string; name: string; text: string }
export interface Bubble { text: string; until: number }

export const EMOTE_GLYPH: Record<string, string> = {
  wave: "👋", smile: "😄", heart: "❤️", party: "🎉", sad: "😢", sleep: "💤",
};

export interface Presence {
  connected: boolean;
  selfId: string | null;
  peerList: PeerMeta[];
  /** Live poses keyed by peer id — mutated in place, read from render loops. */
  posesRef: React.RefObject<Map<string, PeerPose>>;
  /** Transient speech/emote bubbles keyed by peer id (incl. self). */
  bubblesRef: React.RefObject<Map<string, Bubble>>;
  chatLog: ChatLine[];
  count: number;
  sendPose: (pose: PeerPose) => void;
  sendChat: (text: string) => void;
  sendEmote: (e: string) => void;
  sendGift: (to: string, item: string) => void;
}

export function usePresence(
  url: string | undefined,
  self: SelfMeta,
  onGift?: (from: string, name: string, item: string) => void,
): Presence {
  const [connected, setConnected] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [peerList, setPeerList] = useState<PeerMeta[]>([]);
  const [chatLog, setChatLog] = useState<ChatLine[]>([]);
  const [count, setCount] = useState(1);
  const posesRef = useRef<Map<string, PeerPose>>(new Map());
  const bubblesRef = useRef<Map<string, Bubble>>(new Map());
  const chatKey = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const selfRef = useRef(self);
  useEffect(() => { selfRef.current = self; }, [self]);
  const onGiftRef = useRef(onGift);
  useEffect(() => { onGiftRef.current = onGift; }, [onGift]);

  useEffect(() => {
    if (!url) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 1000;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        backoff = 1000;
        setConnected(true);
        ws.send(JSON.stringify({ t: "join", name: selfRef.current.name, look: selfRef.current.look }));
      };

      ws.onmessage = (ev) => {
        let m: ServerMsg;
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        const poses = posesRef.current;
        switch (m.t) {
          case "welcome":
            setSelfId(m.id);
            for (const p of m.peers) poses.set(p.id, { x: p.x, z: p.z, ry: p.ry, st: p.st });
            setPeerList(m.peers.map((p) => ({ id: p.id, name: p.name, look: p.look })));
            break;
          case "join":
            poses.set(m.peer.id, { x: m.peer.x, z: m.peer.z, ry: m.peer.ry, st: m.peer.st });
            setPeerList((list) =>
              list.some((p) => p.id === m.peer.id)
                ? list
                : [...list, { id: m.peer.id, name: m.peer.name, look: m.peer.look }]
            );
            break;
          case "pose": {
            const cur = poses.get(m.id);
            if (cur) { cur.x = m.x; cur.z = m.z; cur.ry = m.ry; cur.st = m.st; }
            else poses.set(m.id, { x: m.x, z: m.z, ry: m.ry, st: m.st });
            break;
          }
          case "update":
            setPeerList((list) => list.map((p) => (p.id === m.id ? { ...p, name: m.name, look: m.look } : p)));
            break;
          case "leave":
            poses.delete(m.id);
            bubblesRef.current.delete(m.id);
            setPeerList((list) => list.filter((p) => p.id !== m.id));
            break;
          case "count":
            setCount(m.n);
            break;
          case "chat": {
            bubblesRef.current.set(m.id, { text: m.text.slice(0, 80), until: Date.now() + 5000 });
            const key = chatKey.current++;
            setChatLog((log) => [...log.slice(-49), { key, id: m.id, name: m.name, text: m.text }]);
            break;
          }
          case "emote": {
            const glyph = EMOTE_GLYPH[m.e] ?? "❔";
            bubblesRef.current.set(m.id, { text: glyph, until: Date.now() + 2500 });
            break;
          }
          case "gift":
            onGiftRef.current?.(m.from, m.name, m.item);
            break;
        }
      };

      const onDown = () => {
        setConnected(false);
        setPeerList([]);
        posesRef.current.clear();
        if (!closed) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15_000);
        }
      };
      ws.onclose = onDown;
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url]);

  // Re-announce name/look when they change (e.g. wallet connects, avatar edited).
  useEffect(() => {
    const ws = wsRef.current;
    if (connected && ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: "update", name: self.name, look: self.look }));
    }
  }, [connected, self.name, self.look]);

  const sendPose = useCallback((pose: PeerPose) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: "pose", x: pose.x, z: pose.z, ry: pose.ry, st: pose.st }));
    }
  }, []);
  const sendChat = useCallback((text: string) => {
    const ws = wsRef.current;
    const t = text.trim().slice(0, 200);
    if (t && ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "chat", text: t }));
  }, []);
  const sendEmote = useCallback((e: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "emote", e }));
  }, []);
  const sendGift = useCallback((to: string, item: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "gift", to, item }));
  }, []);

  return { connected, selfId, peerList, posesRef, bubblesRef, chatLog, count, sendPose, sendChat, sendEmote, sendGift };
}
