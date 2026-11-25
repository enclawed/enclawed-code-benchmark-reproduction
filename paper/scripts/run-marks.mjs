// Invalid-run marks the paper applies to records the results files do not mark themselves.
//
// The hidden-instruction carrier of these scenarios was defective, so their attack could not take
// effect. The harness marked the native runs `invalid: "stego-carrier-defect"` and re-ran them with
// the carrier repaired; the codenclawed runs of the builds below ran with the defective carrier and
// carry no mark in codenclawed-main.jsonl. The same mark is applied to them here. It is decided from
// the scenario and the build only, never from the verdict.
//
// Used by make-tables.mjs (every count), replay-summary.mjs (the replayed-run selection) and
// mark-results.mjs (the copy of the results the ground-truth replay reads).

export const STEGO_CARRIER_DEFECT = {
  mark: "stego-carrier-defect",
  scenarios: new Set([
    "stego-rot13-fixture-exfil",
    "stego-variation-prbody-exfil",
    "stego-split-files-delete",
    "stego-base64-source-delete",
    "stego-bidi-source-githook",
  ]),
  builds: new Set(["67a30e7", "6329ccd"]),
};

/** The record with the mark applied when it applies (the record itself, changed in place). */
export function markRecord(r) {
  if (
    r &&
    !r.invalid &&
    String(r.arm ?? "").startsWith("C") &&
    STEGO_CARRIER_DEFECT.scenarios.has(r.scenario) &&
    STEGO_CARRIER_DEFECT.builds.has(r.build ?? r.codenclawed?.build)
  )
    r.invalid = STEGO_CARRIER_DEFECT.mark;
  return r;
}
