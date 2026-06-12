"use client";

import { useState } from "react";

function MarkdownOutput({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={i} className="bg-gray-900 text-gray-100 rounded-md p-3 text-xs overflow-x-auto my-3 font-mono">
          {lang && <div className="text-gray-500 text-[10px] mb-2 uppercase tracking-wider">{lang}</div>}
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      elements.push(<h3 key={i} className="font-semibold text-gray-800 text-sm mt-4 mb-1">{renderInline(line.slice(4))}</h3>);
    } else if (line.startsWith("## ")) {
      elements.push(<h2 key={i} className="font-semibold text-gray-900 text-base mt-5 mb-1">{renderInline(line.slice(3))}</h2>);
    } else if (line.startsWith("# ")) {
      elements.push(<h1 key={i} className="font-bold text-gray-900 text-lg mt-5 mb-2">{renderInline(line.slice(2))}</h1>);
    }
    // Bullet
    else if (line.match(/^[-*] /)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*] /)) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={i} className="list-disc list-inside space-y-0.5 my-2 text-gray-700">
          {items.map((item, idx) => <li key={idx} className="text-sm">{renderInline(item)}</li>)}
        </ul>
      );
      continue;
    }
    // Numbered list
    else if (line.match(/^\d+\. /)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\. /)) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      elements.push(
        <ol key={i} className="list-decimal list-inside space-y-0.5 my-2 text-gray-700">
          {items.map((item, idx) => <li key={idx} className="text-sm">{renderInline(item)}</li>)}
        </ol>
      );
      continue;
    }
    // Blank line
    else if (line.trim() === "") {
      elements.push(<div key={i} className="h-2" />);
    }
    // Paragraph
    else {
      elements.push(<p key={i} className="text-sm text-gray-700 leading-relaxed">{renderInline(line)}</p>);
    }

    i++;
  }

  return <div>{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

interface Props {
  agentId: string;
  agentName: string;
  capabilities: string[];
  hasExternalEndpoint: boolean;
}

type Step = "idle" | "running" | "done" | "error";

function suggestPrompt(capabilities: string[]): string {
  const cap = capabilities[0]?.toLowerCase() ?? "";
  if (cap.includes("research") || cap.includes("analysis")) return "Summarize the key trends in AI agent infrastructure in 2025.";
  if (cap.includes("trading") || cap.includes("finance")) return "What are the main risks of a momentum trading strategy?";
  if (cap.includes("crypto") || cap.includes("defi")) return "Explain how automated market makers work in DeFi.";
  if (cap.includes("coding") || cap.includes("development")) return "Review this function: function add(a, b) { return a + b; }";
  if (cap.includes("writing") || cap.includes("content")) return "Write a one-paragraph intro for a developer tool landing page.";
  if (cap.includes("onchain") || cap.includes("blockchain")) return "What does a Solana transaction signature look like and what does it prove?";
  if (cap.includes("strategy")) return "What are three ways an AI agent could reduce its API costs?";
  if (cap.includes("seo")) return "List five on-page SEO factors that most affect ranking.";
  if (cap.includes("social")) return "Write a tweet announcing an open-source AI agent marketplace.";
  if (cap.includes("audit")) return "What are the top three smart contract vulnerabilities to check for?";
  if (cap.includes("data")) return "How would you detect outliers in a time-series dataset?";
  if (cap.includes("report")) return "What should a good weekly engineering metrics report include?";
  if (cap.includes("email")) return "Write a short cold outreach email to a developer who just published an AI library.";
  if (cap.includes("web")) return "What is the difference between SSR and SSG in a Next.js app?";
  return "What can you help me with? Give a short summary of your capabilities.";
}

const LIMIT = 3;

function getStoredRemaining(agentId: string): number {
  try {
    const raw = localStorage.getItem(`demo-remaining:${agentId}`);
    return raw !== null ? Math.max(0, Number(raw)) : LIMIT;
  } catch { return LIMIT; }
}

function storeRemaining(agentId: string, value: number) {
  try { localStorage.setItem(`demo-remaining:${agentId}`, String(value)); } catch { /* noop */ }
}

export default function TestAgent({ agentId, agentName, capabilities, hasExternalEndpoint }: Props) {
  const [task, setTask] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [output, setOutput] = useState("");
  const [latency, setLatency] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number>(() => getStoredRemaining(agentId));
  const [error, setError] = useState<string | null>(null);

  if (hasExternalEndpoint) return null;

  const placeholder = suggestPrompt(capabilities);

  async function handleRun() {
    const input = task.trim() || placeholder;
    setStep("running");
    setOutput("");
    setError(null);
    setLatency(null);

    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: input }),
      });

      if (!res.ok) {
        const data = await res.json() as { message?: string; error?: string };
        const msg = data.message ?? data.error ?? "Test failed";
        setError(res.status === 429 ? "You've used your 3 free demo calls. Connect your Phantom wallet to continue." : msg);
        setStep("error");
        return;
      }

      if (!res.body) {
        setError("No response body received.");
        setStep("error");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as {
              text?: string;
              done?: boolean;
              latencyMs?: number;
              remaining?: number;
              error?: string;
            };

            if (data.text) {
              setOutput((prev) => prev + data.text);
            } else if (data.done) {
              receivedDone = true;
              setLatency(data.latencyMs ?? null);
              const rem = data.remaining ?? 0;
              setRemaining(rem);
              storeRemaining(agentId, rem);
              setStep("done");
            } else if (data.error) {
              receivedDone = true;
              setError(data.error);
              setStep("error");
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (!receivedDone) {
        setStep("done");
      }
    } catch {
      setError("Network error — could not reach the test endpoint.");
      setStep("error");
    }
  }

  function handleReset() {
    setStep("idle");
    setTask("");
    setOutput("");
    setError(null);
  }

  const isRunning = step === "running";

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden mb-10">
      <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Try this agent</p>
        <span className="text-xs text-gray-400">Free demo · {remaining} call{remaining !== 1 ? "s" : ""} remaining</span>
      </div>

      <div className="p-5">
        {(step === "idle" || step === "error") && (
          <>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={placeholder}
              rows={3}
              maxLength={500}
              className="w-full text-sm border border-gray-200 rounded-lg p-3 bg-white resize-none focus:outline-none focus:ring-1 focus:ring-gray-400 placeholder:text-gray-300"
            />
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={handleRun}
                className="text-sm px-4 py-2 bg-[#0a0a0a] hover:bg-[#222] text-white rounded-lg font-medium transition-colors"
              >
                Run Test
              </button>
              {step === "error" && error && (
                <p className="text-xs text-red-500">{error}</p>
              )}
            </div>
          </>
        )}

        {(step === "running" || step === "done") && (
          <div>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 min-h-16">
              {isRunning && !output && (
                <span className="text-sm text-gray-300">Calling {agentName}…</span>
              )}
              {output && <MarkdownOutput text={output} />}
              {isRunning && (
                <span className="inline-block w-2 h-4 bg-gray-400 ml-0.5 align-text-bottom animate-pulse" />
              )}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-4 text-xs text-gray-400">
                {step === "done" && latency !== null && (
                  <span>{(latency / 1000).toFixed(1)}s</span>
                )}
              </div>
              {step === "done" && (
                <button
                  onClick={handleReset}
                  className="text-xs text-gray-400 hover:text-gray-700 transition-colors"
                >
                  Run another →
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
