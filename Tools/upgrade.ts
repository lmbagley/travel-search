/**
 * upgrade.ts — a rough upgrade estimate, made mechanical.
 *
 * Premium fare-class depth plus physically open premium seats, discounted at
 * connection hubs crowded with elites and scaled by your status. Every weight lives in
 * `upgrade_estimate` in your config; these are opinions to tune, not airline rules.
 * With no `upgrade_estimate` block the estimate is simply not shown.
 */

import type { Config } from "./painfulness.ts";
import type { AvailItinerary } from "./seatmap-api.ts";

export interface UpgradeEstimate {
  score: number;
  label: "high" | "medium" | "low";
  openPremiumSeats: number | undefined; // undefined = no premium seat map was read
  premiumBucketSum: number;
  connectionAirports: string[];
}

interface UpgradeCfg {
  premium_buckets: Record<string, string[]>;
  weights: { open_premium_seats: number; premium_bucket_sum: number };
  hub_factor?: Record<string, number>;
  tier_factor?: Record<string, number>;
  labels: { high: number; medium: number };
}

export function upgradeConfig(cfg: Config): UpgradeCfg | undefined {
  const u = cfg.upgrade_estimate as UpgradeCfg | undefined;
  if (!u) return undefined;
  if (!u.premium_buckets || !u.weights || !u.labels) {
    throw new Error("upgrade_estimate needs premium_buckets, weights and labels (see config.example.yaml)");
  }
  return u;
}

/** Your status with this carrier, from traveler.programs. */
export function statusFor(cfg: Config, airline: string): string | undefined {
  return cfg.traveler?.programs?.find((p) => p.airline === airline)?.status;
}

export function upgradeEstimate(cfg: Config, itin: AvailItinerary, openPremiumSeats: number | undefined): UpgradeEstimate | undefined {
  const u = upgradeConfig(cfg);
  if (!u) return undefined;
  const airline = itin.segments[0]?.airline ?? "";
  const premium = u.premium_buckets[airline] ?? [];
  const status = statusFor(cfg, airline);
  const tierFactor = (status ? u.tier_factor?.[status] : undefined) ?? u.tier_factor?.default ?? 1;

  let premiumBucketSum = 0;
  for (const seg of itin.segments) for (const b of seg.buckets) if (premium.includes(b.cls)) premiumBucketSum += b.count;

  const connectionAirports = itin.segments.slice(0, -1).map((s) => s.destination);
  let hub = 1;
  for (const c of connectionAirports) hub *= u.hub_factor?.[c] ?? u.hub_factor?.default ?? 1;

  const seatsTerm = openPremiumSeats === undefined ? 0 : u.weights.open_premium_seats * openPremiumSeats;
  const score = Math.round((seatsTerm + u.weights.premium_bucket_sum * premiumBucketSum) * hub * tierFactor);
  const label = score >= u.labels.high ? "high" : score >= u.labels.medium ? "medium" : "low";
  return { score, label, openPremiumSeats, premiumBucketSum, connectionAirports };
}
