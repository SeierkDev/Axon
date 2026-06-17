"use client";

import { useEffect, useRef } from "react";

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  label?: string;
}

interface Packet {
  from: number;
  to: number;
  progress: number;
  speed: number;
}

export default function NetworkCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const LABELS = ["research-agent", "crypto-agent", "data-agent", "code-agent", "audit-agent", "axon", "wallet-agent", "defi-agent"];

    let animId: number;
    let W = 0, H = 0;

    function resize() {
      if (!canvas) return;
      W = canvas.offsetWidth;
      H = canvas.offsetHeight;
      canvas.width = W * devicePixelRatio;
      canvas.height = H * devicePixelRatio;
      ctx!.scale(devicePixelRatio, devicePixelRatio);
    }

    resize();
    window.addEventListener("resize", resize);

    // Create nodes
    const nodes: Node[] = Array.from({ length: 18 }, (_, i) => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: i === 0 ? 5 : Math.random() * 2.5 + 2,
      label: i < LABELS.length ? LABELS[i] : undefined,
    }));

    // Center AXON node
    nodes[5].x = W / 2;
    nodes[5].y = H / 2;
    nodes[5].radius = 6;
    nodes[5].vx = 0;
    nodes[5].vy = 0;

    const packets: Packet[] = [];

    function spawnPacket() {
      const from = Math.floor(Math.random() * nodes.length);
      let to = Math.floor(Math.random() * nodes.length);
      while (to === from) to = Math.floor(Math.random() * nodes.length);
      packets.push({ from, to, progress: 0, speed: Math.random() * 0.008 + 0.004 });
    }

    for (let i = 0; i < 5; i++) spawnPacket();

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);

      const dark = document.documentElement.classList.contains("dark");
      const r = dark ? 220 : 10;
      const g = dark ? 220 : 10;
      const b = dark ? 220 : 10;

      // Draw edges between nearby nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const maxDist = 160;
          if (dist < maxDist) {
            const alpha = (1 - dist / maxDist) * 0.12;
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
            ctx.lineWidth = 0.8;
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Draw packets traveling along edges
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        p.progress += p.speed;
        if (p.progress >= 1) {
          packets.splice(i, 1);
          spawnPacket();
          continue;
        }
        const n1 = nodes[p.from];
        const n2 = nodes[p.to];
        const x = n1.x + (n2.x - n1.x) * p.progress;
        const y = n1.y + (n2.y - n1.y) * p.progress;
        const alpha = Math.sin(p.progress * Math.PI) * 0.7;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fill();
      }

      // Draw nodes
      for (const node of nodes) {
        // Outer ring for AXON node
        if (node.label === "axon") {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${b},0.15)`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.fillStyle = node.label === "axon" ? `rgba(${r},${g},${b},0.85)` : `rgba(${r},${g},${b},0.2)`;
        ctx.fill();
      }

      // Update positions
      for (const node of nodes) {
        if (node.label === "axon") continue;
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > W) node.vx *= -1;
        if (node.y < 0 || node.y > H) node.vy *= -1;
      }

      animId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity: 0.6 }}
    />
  );
}
