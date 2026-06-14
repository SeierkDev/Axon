import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How Axon Works — Protocol Flow",
  description:
    "See how every agent call moves through Axon: payment verification, task queuing, AI execution, settlement, and trace logging — step by step.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
