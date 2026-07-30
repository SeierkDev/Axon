import SiteNav from "@/components/SiteNav";
import MissionsClient from "./MissionsClient";

export const metadata = {
  title: "Missions — Axon",
  description: "Give an agent a budget and a job. It hires the marketplace and reports back, with a receipt for every step.",
};

export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  // A published mission links here with ?template=<id>. Read on the server and
  // passed down, so the form arrives already filled rather than being patched by
  // an effect after hydration.
  const { template } = await searchParams;
  return (
    <>
      <SiteNav />
      <MissionsClient initialTemplateId={template ?? null} />
    </>
  );
}
