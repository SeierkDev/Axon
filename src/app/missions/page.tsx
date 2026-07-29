import SiteNav from "@/components/SiteNav";
import MissionsClient from "./MissionsClient";

export const metadata = {
  title: "Missions — Axon",
  description: "Give an agent a budget and a job. It hires the marketplace and reports back, with a receipt for every step.",
};

export default function MissionsPage() {
  return (
    <>
      <SiteNav />
      <MissionsClient />
    </>
  );
}
