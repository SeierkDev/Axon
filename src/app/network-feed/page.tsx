import React from "react";
import { getRecentPosts } from "@/lib/telegram";
import { getNetworkStats } from "@/lib/analytics";
import SiteNav from "@/components/SiteNav";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Network Feed — Axon" };

const TYPE_LABEL: Record<string, string> = {
  snapshot: "Network Update",
  agent: "New Agent",
  task_milestone: "Milestone",
  usdc_milestone: "Milestone",
  activity: "Task Activity",
};

const TYPE_DOT: Record<string, string> = {
  snapshot: "bg-blue-500",
  agent: "bg-violet-500",
  task_milestone: "bg-green-500",
  usdc_milestone: "bg-amber-500",
  activity: "bg-cyan-500",
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function unescape(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function PostContent({ html }: { html: string }) {
  const nodes: React.ReactNode[] = [];
  const pattern = /<b>([\s\S]*?)<\/b>|<a href="([^"]*)">([\s\S]*?)<\/a>|<[^>]+>/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(html)) !== null) {
    if (m.index > last) nodes.push(unescape(html.slice(last, m.index)));
    if (m[0].startsWith("<b>")) {
      nodes.push(<strong key={key++}>{unescape(m[1])}</strong>);
    } else if (m[0].startsWith("<a ")) {
      nodes.push(
        <a key={key++} href={m[2]} target="_blank" rel="noopener noreferrer"
          className="inline-block mt-3 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline transition-colors">
          {unescape(m[3])}
        </a>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < html.length) nodes.push(unescape(html.slice(last)));

  return (
    <p className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-line leading-relaxed">{nodes}</p>
  );
}

export default function NetworkFeedPage() {
  const posts = getRecentPosts(20);
  const stats = getNetworkStats();

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-2xl mx-auto px-6 pt-32 pb-24">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Network Feed</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                Live updates from the Axon agent network, posted automatically.
              </p>
            </div>
            <a
              href="https://t.me/axonnetworkfeed"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#229ED9] hover:bg-[#1a8cc2] text-white text-sm font-medium rounded-lg transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.917 7.257l-1.699 8.012c-.128.576-.46.716-.932.446l-2.574-1.896-1.241 1.195c-.138.137-.252.252-.515.252l.183-2.607 4.742-4.283c.207-.184-.044-.286-.32-.103L7.89 14.333 5.36 13.55c-.563-.175-.574-.563.117-.835l9.635-3.715c.47-.17.88.113.805.257z" />
              </svg>
              Join Channel
            </a>
          </div>

          {/* Bot status */}
          <div className="mt-4 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              @AxonNetworkBot active
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">{posts.length} posts</span>
          </div>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          {[
            { label: "Agents", value: stats.agents.total },
            { label: "Tasks completed", value: stats.tasks.completed.toLocaleString('en-US') },
            { label: "USDC transacted", value: `$${stats.payments.totalUsdcTransacted.toFixed(2)}` },
          ].map((s) => (
            <div key={s.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
              <div className="text-base font-semibold text-gray-900 dark:text-white">{s.value}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Feed */}
        {posts.length === 0 ? (
          <div className="text-center py-16 text-gray-400 dark:text-gray-500 text-sm">
            No posts yet. The bot will start posting once the cron is configured.
          </div>
        ) : (
          <div className="h-[600px] overflow-y-auto pr-1 flex flex-col gap-3 scrollbar-thin">
            {posts.map((post) => (
              <article
                key={post.post_id}
                className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-5 shrink-0"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full ${TYPE_DOT[post.type] ?? "bg-gray-400"}`} />
                  <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    {TYPE_LABEL[post.type] ?? post.type}
                  </span>
                  <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{formatRelative(post.created_at)}</span>
                </div>
                <PostContent html={post.content} />
              </article>
            ))}
          </div>
        )}

        <div className="mt-8 text-center">
          <a
            href="https://t.me/axonnetworkfeed"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Follow @AxonNetworkBot on Telegram for real-time updates →
          </a>
        </div>
      </main>
    </div>
  );
}
