// Informational cost tracking for BYOK — NOT billing. The user pays their own providers directly; we only
// SHOW what a render cost them, in cents (real OpenRouter usage cost). Reset at the start of each op and
// snapshotted into that op's result. (Engine runs in-process; ops are effectively serialized by the UI.)
let cents = 0;

export function costReset(): void {
  cents = 0;
}

export function costAdd(c: number): void {
  if (Number.isFinite(c) && c > 0) cents += c;
}

export function costTotal(): number {
  return Math.round(cents * 1e4) / 1e4;
}

/** USD cost from an OpenRouter response (we send usage:{include:true}) -> cents. 0 if absent. */
export function orCost(resp: any): number {
  try {
    const u = resp?.usage || {};
    let c = u.cost;
    if (c == null) {
      const cd = u.cost_details || {};
      c = cd.upstream_inference_cost ?? cd.cost;
    }
    return c != null ? Number(c) * 100 : 0;
  } catch {
    return 0;
  }
}
