# Session Review: Φ Accrual Failure Detector

**Reviewed:** 2026-03-15  
**Files:** `crew/phi-detector.ts` (279 LOC), `tests/crew/phi-detector.test.ts` (33 tests)  
**Verdict:** ✅ Ship-ready with minor notes  

---

## Summary

Clean, well-structured implementation of Hayashibara et al.'s φ accrual failure detector. The math is correct, edge cases are handled, tests are thorough, and the API is clean. No blocking bugs or security issues found.

---

## Acceptance Criteria Trace

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Regular heartbeats keep Φ<1 | ✅ | `keeps Φ < 1 for regular heartbeats checked shortly after` — checks at lastTime+200 |
| Missed heartbeats raise Φ>3 | ✅ | `raises Φ > 3 for significantly missed heartbeats` — 5x interval |
| Different agent rhythms → different baselines | ✅ | `produces different Φ for same delay with different rhythms` — fast vs slow detector |
| Configurable windowSize and minSamples | ✅ | Constructor accepts `PhiDetectorConfig`, tests create detectors with custom values |
| Φ = −log₁₀(P_later) using normal CDF | ✅ | `phi()` method line: `Math.min(-Math.log10(pLater), PHI_MAX)` |
| Thresholds: Φ≥1 degraded, Φ≥3 critical, Φ≥8 failed | ✅ | Constants `PHI_DEGRADED=1`, `PHI_CRITICAL=3`, `PHI_FAILED=8` used in `phiToState()` |

---

## Bugs Found

**None.** No logical errors, no off-by-one issues, no infinite loops, no NaN/Infinity leaks.

---

## Findings

### F1 — Population variance instead of sample variance (Low / Design Choice)

**File:** `crew/phi-detector.ts:220`  
**Code:** `const variance = intervals.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;`

Uses population variance (÷n) not Bessel-corrected sample variance (÷(n-1)). With `minSamples=3`, this underestimates true variance by factor n/(n-1) = 1.5, making stddev ~18% lower than corrected. Effect: the detector is **slightly more sensitive** at low sample counts (3-5 intervals), triggering degraded/critical marginally earlier than theoretically correct.

**Impact:** Low. The stddev floor (`mean * 0.1`) already provides a safety net, and Cassandra's implementation also uses population variance. This is standard practice for accrual detectors where the window *is* the population of interest.

**Recommendation:** Acceptable as-is. If you want to match textbook statistics, change to `/ (n - 1)`. Not required.

### F2 — `intervals.shift()` is O(n) per heartbeat (Low / Performance)

**File:** `crew/phi-detector.ts:106`  
**Code:** `while (state.intervals.length > this.windowSize) { state.intervals.shift(); }`

`Array.shift()` is O(n) due to index reindexing. With default `windowSize=100`, this is negligible. If windowSize were ever set to 10,000+, it would matter.

**Recommendation:** Fine for current use. If window sizes grow large, switch to a circular buffer. Not needed now.

### F3 — No `reset()` or `clear()` method (Low / API Gap)

There's `removeAgent(id)` for individual agents but no bulk `reset()` to clear all tracked agents. Minor API gap if the detector is long-lived and needs periodic clearing.

**Recommendation:** Add if needed, skip if not. Not blocking.

---

## Security Review

| Check | Status | Notes |
|-------|--------|-------|
| External input parsing | ✅ N/A | Pure computational module, no string parsing |
| Network I/O | ✅ N/A | No network calls |
| File I/O | ✅ N/A | No filesystem access |
| Prototype pollution | ✅ Safe | Uses `Map`, no dynamic property assignment |
| Denial of service | ✅ Safe | Window size bounds memory; PHI_MAX caps computation |
| Numeric overflow | ✅ Safe | erfc clamped at ±6, phi capped at PHI_MAX=16 |

**No security issues.**

---

## Test Quality Assessment

**Coverage:** 33 tests across 8 describe blocks. Excellent breadth.

| Category | Tests | Quality |
|----------|-------|---------|
| Construction | 2 | ✅ Default and custom config |
| Heartbeat recording | 4 | ✅ Single, multi-agent, interval building, window cap |
| Φ computation | 7 | ✅ Unknown agent, insufficient samples, boundary, monotonicity, cap |
| Health state mapping | 5 | ✅ All 4 states covered |
| Adaptive baseline | 2 | ✅ Different rhythms, rhythm change adaptation |
| Agent management | 3 | ✅ Remove, unknown remove, empty list |
| Query methods | 3 | ✅ Single, all, empty |
| Edge cases | 5 | ✅ Zero variance, short/long intervals, extreme delay, recovery |

### Minor test gaps (non-blocking):

1. **`minSamples` with non-default value**: A detector is created with `minSamples: 5` but only checked for `instanceof`. No test verifies that it actually requires 5 samples before computing Φ.

2. **Concurrent heartbeat streams**: No test records interleaved heartbeats for two agents in the same detector and verifies independence. Current tests use separate detectors for the rhythm comparison.

3. **Exact threshold boundaries**: No test checks Φ at exactly 1.0, 3.0, or 8.0 to verify `>=` vs `>` in `phiToState`. (The implementation uses `>=` which matches the spec.)

---

## Code Quality

- **Documentation:** Excellent. JSDoc on all public methods, algorithm explanation in file header.
- **Naming:** Clear and consistent. `phi`, `healthState`, `recordHeartbeat` — all self-explanatory.
- **Error handling:** Graceful returns (0, undefined) instead of throws. Appropriate for a monitoring primitive.
- **erfc approximation:** Abramowitz & Stegun 7.1.26 with correct coefficients. Accuracy ~1.5×10⁻⁷ is more than sufficient.
- **Exports:** Clean — types, class, and threshold constants all exported for downstream use.

---

## Verdict

**Ship it.** The implementation is mathematically correct, well-tested, handles edge cases properly, and has no security concerns. The three findings above are all low-severity design notes, not bugs.
