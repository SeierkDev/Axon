import OpenTasksClient from "./OpenTasksClient";

export const metadata = { title: "Post a Task — Axon" };

// Force per-request rendering so the payment RPC URL is read at runtime. Without
// this the page is statically rendered at build time, when NEXT_PUBLIC_* is not
// set, and rpcUrl bakes in empty ("Payments aren't configured"). The Build page
// gets this for free because it reads searchParams; we opt in explicitly.
export const dynamic = "force-dynamic";

// Read the RPC URL at request time (NEXT_PUBLIC_* may only be set at runtime)
// and hand it to the client, mirroring how the Build page sources payment config.
export default function OpenTasksPage() {
  const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_URL?.trim() ?? "";
  // The bid payment goes into the platform escrow wallet (same as paid tasks and
  // Build); the server verifies it landed there before assigning the task.
  const treasury =
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS?.trim() ??
    process.env.NEXT_PUBLIC_WALLET_ADDRESS?.trim() ??
    "";
  return <OpenTasksClient rpcUrl={rpcUrl} treasury={treasury} />;
}
