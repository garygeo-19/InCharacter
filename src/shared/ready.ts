// Ready-across-roles summary for the home pack list (§4.1, §16.1; owner
// fix Nov 2026). A pack row counts everything ready in the pack —
// classroom-ready classes plus usable role sessions — and says what it is,
// e.g. "3 classes ready", "Coach a client ready",
// "1 class · Find your way ready". Only a pack with nothing ready anywhere
// says "Classes coming soon".

export type ReadyRoleCount = {
  key: string;
  title: string;
  count: number;
};

export type ReadyCounts = {
  classes: number;
  roles: ReadyRoleCount[];
};

/** The home row text for one pack's ready counts. */
export function packReadySummary(counts: ReadyCounts): string {
  const parts: string[] = [];
  if (counts.classes > 0) {
    parts.push(`${counts.classes} class${counts.classes === 1 ? '' : 'es'}`);
  }
  for (const role of counts.roles) {
    if (role.count > 0) parts.push(role.title);
  }
  if (parts.length === 0) return 'Classes coming soon';
  return `${parts.join(' · ')} ready`;
}

/** Everything ready in the pack, for sorting packs with anything ready first. */
export function packReadyTotal(counts: ReadyCounts): number {
  return counts.classes + counts.roles.reduce((n, r) => n + r.count, 0);
}
