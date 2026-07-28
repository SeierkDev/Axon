import SiteNav from "@/components/SiteNav";
import CommerceClient from "./CommerceClient";

export const metadata = {
  title: "Purchases — Axon",
  description: "Approve what your agents want to buy. Nothing is charged without your signature.",
};

export default function CommercePage() {
  return (
    <>
      <SiteNav />
      <CommerceClient />
    </>
  );
}
