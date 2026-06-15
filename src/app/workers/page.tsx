import type { Metadata } from "next";
import WorkersDashboard from "./WorkersDashboard";

export const metadata: Metadata = { title: "Worker Metrics — Axon" };

export default function WorkersPage() {
  return <WorkersDashboard />;
}
