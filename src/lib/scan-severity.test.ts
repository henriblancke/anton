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
    expect(classOfSignal(signal({ Source: "githygiene" }))).toBe("security");
    expect(classOfSignal(signal({ Source: "dephealth" }))).toBe("dependencies");
    expect(classOfSignal(signal({ Source: "todos" }))).toBe("debt");
    expect(classOfSignal(signal({ Source: "lotteryrisk" }))).toBe("risk");
    expect(classOfSignal(signal({ Source: "docstale" }))).toBe("docs");
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
