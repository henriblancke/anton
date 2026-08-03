/**
 * The stringer severity model (anton-bz1w). What matters here: a signal is never silently dropped
 * off either axis (an unknown collector still counts), security signals are not buried by their
 * collector's default, and the triage mapping a project configures is the one that reaches the
 * prompt.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCAN_SEVERITY_POLICY,
  SCAN_SEVERITIES,
  annotateSignal,
  classOfSignal,
  formatScanSeverityPolicy,
  resolveScanSeverityPolicy,
  severityOfSignal,
  type ScanSignal,
} from "./scan-severity";

const signal = (s: ScanSignal): ScanSignal => s;

describe("classOfSignal", () => {
  it("maps each collector to the class a founder would file it under", () => {
    expect(classOfSignal(signal({ Source: "vuln" }))).toBe("security");
    expect(classOfSignal(signal({ Source: "dephealth" }))).toBe("dependencies");
    expect(classOfSignal(signal({ Source: "todos" }))).toBe("debt");
    expect(classOfSignal(signal({ Source: "lotteryrisk" }))).toBe("risk");
    expect(classOfSignal(signal({ Source: "docstale" }))).toBe("docs");
  });

  it("splits githygiene by what it found — a secret is security, the rest is hygiene risk", () => {
    // The triage contract files merge-conflict markers and large binaries as risk/hygiene cleanup;
    // classing them `security` both over-reports the panel and mislabels triage's own input.
    expect(classOfSignal(signal({ Source: "githygiene", Kind: "committed-secret" }))).toBe(
      "security",
    );
    expect(classOfSignal(signal({ Source: "githygiene", Tags: ["aws-api-key"] }))).toBe("security");
    expect(classOfSignal(signal({ Source: "githygiene", Kind: "merge-conflict" }))).toBe("risk");
    expect(classOfSignal(signal({ Source: "githygiene", Kind: "large-binary" }))).toBe("risk");
    expect(classOfSignal(signal({ Source: "githygiene" }))).toBe("risk");
  });

  it("files an unknown collector as `other` rather than dropping it", () => {
    expect(classOfSignal(signal({ Source: "brand-new-collector" }))).toBe("other");
    expect(classOfSignal(signal({}))).toBe("other");
  });

  it("reads stringer's PascalCase and a lowercase fixture alike", () => {
    expect(classOfSignal(signal({ source: "vuln" }))).toBe("security");
  });
});

describe("severityOfSignal", () => {
  it("prefers an explicit severity, should stringer ever emit one", () => {
    expect(severityOfSignal(signal({ Source: "todos", Severity: "CRITICAL" }))).toBe("critical");
  });

  it("reads stringer's bd Priority next — 0 is critical, 4 is backlog", () => {
    expect(severityOfSignal(signal({ Source: "todos", Priority: 0 }))).toBe("critical");
    expect(severityOfSignal(signal({ Source: "todos", Priority: 1 }))).toBe("high");
    expect(severityOfSignal(signal({ Source: "todos", Priority: 2 }))).toBe("medium");
    expect(severityOfSignal(signal({ Source: "vuln", Priority: 4 }))).toBe("low");
  });

  it("promotes a secret or a CVE whatever collector found it", () => {
    expect(severityOfSignal(signal({ Source: "githygiene", Kind: "committed-secret" }))).toBe(
      "critical",
    );
    expect(severityOfSignal(signal({ Source: "github", Tags: ["cve"] }))).toBe("critical");
  });

  it("promotes a secret or a CVE OVER a collector's own Priority", () => {
    // `Priority` is a queueing hint, not a security judgment: a committed key carrying P2 must not
    // be recorded as medium, or the trend understates it and triage files it `risk:low`.
    expect(
      severityOfSignal(signal({ Source: "githygiene", Kind: "committed-secret", Priority: 2 })),
    ).toBe("critical");
    expect(severityOfSignal(signal({ Source: "dephealth", Tags: ["CVE-2026-1"], Priority: 3 }))).toBe(
      "critical",
    );
  });

  it("floors rather than overrides — a signal already ranked worse keeps its rank", () => {
    expect(
      severityOfSignal(signal({ Source: "githygiene", Kind: "merge-conflict", Priority: 0 })),
    ).toBe("critical");
  });

  it("lets a collector's Priority outrank the non-security kind rules", () => {
    // "deprecated" describes how a dependency is aging; a collector that priced it P1 itself has
    // the better number, so this rule stays a default rather than becoming a ceiling.
    expect(severityOfSignal(signal({ Source: "dephealth", Kind: "deprecated-dep", Priority: 1 }))).toBe(
      "high",
    );
  });

  it("does not promote on a generic word — `high-churn` is churn, not high severity", () => {
    expect(severityOfSignal(signal({ Source: "gitlog", Kind: "high-churn" }))).toBe("low");
  });

  it("falls back to the collector's default, and to medium for an unknown one", () => {
    expect(severityOfSignal(signal({ Source: "vuln", Kind: "osv" }))).toBe("critical");
    expect(severityOfSignal(signal({ Source: "todos", Kind: "todo" }))).toBe("low");
    expect(severityOfSignal(signal({ Source: "dephealth", Kind: "stale-dep" }))).toBe("medium");
    expect(severityOfSignal(signal({ Source: "future-collector", Kind: "whatever" }))).toBe(
      "medium",
    );
  });

  it("ignores a non-integer priority instead of scoring it", () => {
    expect(severityOfSignal(signal({ Source: "todos", Priority: null }))).toBe("low");
    expect(severityOfSignal(signal({ Source: "todos", Priority: "not a number" }))).toBe("low");
  });
});

describe("resolveScanSeverityPolicy", () => {
  it("is the shipped mapping when a project configured nothing", () => {
    expect(resolveScanSeverityPolicy()).toEqual(DEFAULT_SCAN_SEVERITY_POLICY);
    expect(resolveScanSeverityPolicy({})).toEqual(DEFAULT_SCAN_SEVERITY_POLICY);
  });

  it("applies a project's override without disturbing the severities it left alone", () => {
    const policy = resolveScanSeverityPolicy({ medium: { risk: "high", priority: 1 } });
    expect(policy.medium).toEqual({ risk: "high", priority: 1 });
    expect(policy.low).toEqual(DEFAULT_SCAN_SEVERITY_POLICY.low);
    expect(policy.critical).toEqual(DEFAULT_SCAN_SEVERITY_POLICY.critical);
  });
});

describe("formatScanSeverityPolicy", () => {
  it("renders every severity, so the prompt can never inherit a half-stated mapping", () => {
    const table = formatScanSeverityPolicy(resolveScanSeverityPolicy());
    for (const severity of SCAN_SEVERITIES) expect(table).toContain(`| ${severity} |`);
    expect(table).toContain("| critical | risk:high | P0 |");
    expect(table).toContain("| low | risk:low | P3 |");
  });

  it("renders the project's values, not the defaults it overrode", () => {
    const table = formatScanSeverityPolicy(
      resolveScanSeverityPolicy({ low: { risk: "high", priority: 0 } }),
    );
    expect(table).toContain("| low | risk:high | P0 |");
    expect(table).not.toContain("| low | risk:low | P3 |");
  });
});

describe("annotateSignal", () => {
  it("stamps the derived reading in place, so re-serializing the envelope carries it", () => {
    const envelope = { signals: [signal({ Source: "vuln", Kind: "cve" })] };
    const annotated = annotateSignal(envelope.signals[0]);

    expect(annotated).toMatchObject({ AntonSeverity: "critical", AntonClass: "security" });
    expect(envelope.signals[0]).toBe(annotated); // mutated, not copied
    expect(JSON.parse(JSON.stringify(envelope)).signals[0].AntonSeverity).toBe("critical");
  });

  it("re-derives from stringer's own fields rather than echoing a previous annotation", () => {
    // The annotation must not shadow `Severity`, which rankSignal reads first — a re-scan of an
    // annotated file would otherwise keep answering with anton's last verdict.
    const once = annotateSignal(signal({ Source: "todos", Kind: "todo" }));
    expect(once.AntonSeverity).toBe("low");
    once.Source = "vuln";
    expect(annotateSignal(once).AntonSeverity).toBe("critical");
  });
});
