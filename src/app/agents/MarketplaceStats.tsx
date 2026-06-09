"use client";

import AnimatedCounter from "@/components/AnimatedCounter";

interface Props {
  total: number;
  paid: number;
  categories: number;
  active: number;
}

export function MarketplaceStats({ total, paid, categories, active }: Props) {
  const stats = [
    { label: "Listed Agents",    value: total },
    { label: "Priced Listings",  value: paid },
    { label: "Categories",       value: categories },
    { label: "Active Agents",    value: active },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-6 py-6 border-y border-gray-100 mb-10">
      {stats.map((s, i) => (
        <div
          key={s.label}
          style={{ animation: `fade-up 0.5s ease ${i * 80}ms both` }}
        >
          <p className="text-2xl font-bold text-gray-900">
            <AnimatedCounter value={s.value} />
          </p>
          <p className="text-xs text-gray-400 mt-1">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
