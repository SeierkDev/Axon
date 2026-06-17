import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import WorkflowClient from "./WorkflowClient";

export const metadata = { title: "Workflow — Axon" };

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <Link
          href="/dashboard"
          className="text-sm text-gray-400 hover:text-gray-700 dark:hover:text-white transition-colors mb-8 inline-block"
        >
          ← Dashboard
        </Link>

        <div className="mb-8">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-2">WORKFLOW</p>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white font-mono">
            {workflowId.length > 16 ? `${workflowId.slice(0, 8)}…${workflowId.slice(-6)}` : workflowId}
          </h1>
        </div>

        <WorkflowClient workflowId={workflowId} />
      </main>
    </div>
  );
}
