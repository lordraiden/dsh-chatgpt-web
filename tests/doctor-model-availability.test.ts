/**
 * The doctor reports which catalogue rows the configured account can actually serve.
 *
 * `/v1/models` publishes provider-qualified rows — the Luna-only account's `chatgpt-web/luna` and
 * `chatgpt-web/think`, the Sol account's `chatgpt-web/light|medium|high`, and the Pro-gated
 * `chatgpt-web/extra-high|pro` — but only the rows the account authority already approved. An
 * operator who points a client at a row the account cannot answer learns that on the first call, as a
 * typed 400. This check closes that gap: it lists the whole catalogue of the active interaction mode
 * and classifies each row as `available`, `unavailable` (the account tier cannot serve it) or
 * `unknown` (the capability state does not say).
 *
 * The contract this suite pins:
 *
 * - the rows come from the catalogue's own route table and the decision from the ONE capability
 *   owner (`capabilityState` / `solAvailable` / `proAvailable` through the route authority) — no
 *   second list and no second truth;
 * - an unknown capability state is a `warning`, never an `error`, so it cannot fail a doctor run;
 * - the check never throws, and its report carries no credential, host path or network fact.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { defaultConfig, getConfigPath, saveConfig, type AppConfig } from "../src/config";
import {
  MODEL_AVAILABILITY_CHECK_ID,
  formatDoctorReport,
  modelAvailabilityCheck,
  modelAvailabilityRows,
  runDoctor,
  type DoctorCheck,
} from "../src/doctor";
import {
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
} from "../src/chatgpt-web-models";
import {
  candidateChatGptWebRoutes,
  classifyChatGptWebRoute,
  createChatGptWebRouteAuthority,
  requireChatGptWebRoute,
  type ChatGptWebCapabilityStateSet,
} from "../src/chatgpt-web-authority";
import {
  captureChatGptWebHome,
  restoreChatGptWebHome,
  useTemporaryChatGptWebHome,
} from "./support/chatgpt-web-home";

/** The Sol rows a Sol+Pro account is served, in catalogue order. */
const SOL_ROWS = ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"];
const PRO_ROWS = ["chatgpt-web/extra-high", "chatgpt-web/pro"];
const LUNA_ROWS = ["chatgpt-web/luna", "chatgpt-web/think"];

function configWith(overrides: Partial<AppConfig>): AppConfig {
  return { ...defaultConfig(), ...overrides };
}

function availability(config: AppConfig): Map<string, string> {
  return new Map(modelAvailabilityRows(config).map(row => [row.model, row.availability]));
}

describe("doctor model availability", () => {
  test("a Sol+Pro account is served every Sol and Pro-gated row", () => {
    const config = configWith({
      solAvailable: true,
      proAvailable: true,
      capabilityState: { solAvailable: "supported", proAvailable: "supported" },
    });
    const rows = availability(config);
    for (const model of [...SOL_ROWS, ...PRO_ROWS]) expect(rows.get(model)).toBe("available");
    // The catalogue owner reserves Luna and Think for Luna-only accounts: a Sol account is served the
    // Sol rows instead, and `requireChatGptWebRoute` refuses the Luna rows for it.
    for (const model of LUNA_ROWS) expect(rows.get(model)).toBe("unavailable");

    const check = modelAvailabilityCheck(config);
    expect(check.id).toBe(MODEL_AVAILABILITY_CHECK_ID);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("5 of 7");
    expect(check.detail).toContain("sol=supported");
    expect(check.detail).toContain("pro=supported");
    expect(check.detail).toContain("chatgpt-web/extra-high");
  });

  test("a Sol account without Pro is not served the Pro-gated rows", () => {
    const config = configWith({
      solAvailable: true,
      proAvailable: false,
      capabilityState: { solAvailable: "supported", proAvailable: "unsupported" },
    });
    const rows = availability(config);
    for (const model of SOL_ROWS) expect(rows.get(model)).toBe("available");
    for (const model of PRO_ROWS) expect(rows.get(model)).toBe("unavailable");
    expect(modelAvailabilityCheck(config).status).toBe("ok");
  });

  test("a Luna-only account is served Luna and Think and nothing else", () => {
    const config = configWith({
      solAvailable: false,
      proAvailable: false,
      capabilityState: { solAvailable: "unsupported", proAvailable: "unsupported" },
    });
    const rows = availability(config);
    for (const model of LUNA_ROWS) expect(rows.get(model)).toBe("available");
    for (const model of [...SOL_ROWS, ...PRO_ROWS]) expect(rows.get(model)).toBe("unavailable");

    const check = modelAvailabilityCheck(config);
    expect(check.status).toBe("ok");
    expect(check.message).toContain("2 of 7");
  });

  test("an unknown capability state marks every row unknown without failing", () => {
    const config = configWith({
      capabilityState: { solAvailable: "unknown", proAvailable: "unknown" },
    });
    const rows = modelAvailabilityRows(config);
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row.availability).toBe("unknown");

    const check = modelAvailabilityCheck(config);
    expect(check.status).toBe("warning");
    expect(check.status).not.toBe("error");
    expect(check.message).toContain("unknown");
    expect(check.detail).toContain("sol=unknown");
    // A warning never fails the report, and it never prints a repair command.
    const rendered = formatDoctorReport({ ok: true, checks: [check] });
    expect(rendered).toContain("Doctor result: ready");
    expect(rendered).not.toContain("Next step:");
  });

  test("the row list is the catalogue's own route table, not a hand-written list", () => {
    expect(modelAvailabilityRows(defaultConfig()).map(row => row.model)).toEqual(
      [...CHATGPT_WEB_LUNA_MODEL_ROUTES, ...CHATGPT_WEB_MODEL_ROUTES].map(route => route.slug),
    );
    const manual = configWith({ browserInteractionMode: "manual" });
    expect(modelAvailabilityRows(manual).map(row => row.model)).toEqual([
      CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
    ]);
    const manualPro = configWith({ browserInteractionMode: "manual", zeroRiskProEnabled: true });
    expect(modelAvailabilityRows(manualPro).map(row => row.model)).toEqual([
      CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
      CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.slug,
    ]);
    expect(modelAvailabilityCheck(manual).status).toBe("ok");
  });

  test("the classification agrees with the refusal path for every capability state", () => {
    const states: ChatGptWebCapabilityStateSet[] = [
      { solAvailable: "supported", proAvailable: "supported" },
      { solAvailable: "supported", proAvailable: "unsupported" },
      { solAvailable: "supported", proAvailable: "unknown" },
      { solAvailable: "unsupported", proAvailable: "unsupported" },
      { solAvailable: "unknown", proAvailable: "unknown" },
    ];
    for (const capabilityState of states) {
      const authority = createChatGptWebRouteAuthority({ capabilityState });
      for (const route of candidateChatGptWebRoutes(authority)) {
        const classification = classifyChatGptWebRoute(route, authority);
        let refusal: Error | undefined;
        try {
          requireChatGptWebRoute(route.slug, authority);
        } catch (error) {
          refusal = error as Error;
        }
        if (classification === "available") {
          expect(refusal).toBeUndefined();
          continue;
        }
        expect(refusal).toBeDefined();
        if (classification === "unknown") {
          expect(refusal?.message).toContain("unknown or unverifiable");
        } else {
          expect(refusal?.message).not.toContain("unknown or unverifiable");
        }
      }
    }
    // Zero Risk has no capability gate of its own: its rows are served by the mode.
    const zeroRisk = createChatGptWebRouteAuthority({
      browserInteractionMode: "manual",
      zeroRiskProEnabled: true,
    });
    for (const route of candidateChatGptWebRoutes(zeroRisk)) {
      expect(classifyChatGptWebRoute(route, zeroRisk)).toBe("available");
    }
  });

  test("an incoherent capability state is reported, never thrown", () => {
    // Pro requires Sol; a configuration that claims otherwise cannot be resolved into an authority.
    const config = configWith({
      capabilityState: { solAvailable: "unsupported", proAvailable: "supported" },
    });
    let check: DoctorCheck | undefined;
    expect(() => {
      check = modelAvailabilityCheck(config);
    }).not.toThrow();
    expect(check?.id).toBe(MODEL_AVAILABILITY_CHECK_ID);
    expect(check?.status).toBe("warning");
    expect(check?.message).toContain("could not be resolved");
  });

  test("the report carries no credential, host path or network fact", () => {
    const check = modelAvailabilityCheck(configWith({
      solAvailable: true,
      proAvailable: true,
      capabilityState: { solAvailable: "supported", proAvailable: "supported" },
    }));
    const text = JSON.stringify(check);
    expect(text).not.toContain(process.cwd());
    expect(text).not.toContain("/home");
    expect(text).not.toContain("cookie");
    expect(text).not.toContain("token");
    expect(text).not.toContain("http");
    expect(text).not.toContain("storageState");
  });

  test("runDoctor wires the check and an unknown state stays a warning", async () => {
    const savedHome = captureChatGptWebHome();
    const home = useTemporaryChatGptWebHome("doctor-model-availability-", { clearFreeHome: true });
    try {
      saveConfig(defaultConfig());
      // A configuration states the tri-state without the compatibility booleans when the account
      // capability is genuinely undecided; that is the shape this check exists for.
      const path = getConfigPath();
      const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      delete persisted.solAvailable;
      delete persisted.proAvailable;
      persisted.capabilityState = { solAvailable: "unknown", proAvailable: "unknown" };
      writeFileSync(path, JSON.stringify(persisted, null, 2));

      const report = await runDoctor({ structuredOutputProbe: false });
      const checks = report.checks.filter(check => check.id === MODEL_AVAILABILITY_CHECK_ID);
      expect(checks).toHaveLength(1);
      expect(checks[0]?.status).toBe("warning");
      expect(report.checks.some(check => check.status === "error" && check.id === MODEL_AVAILABILITY_CHECK_ID))
        .toBe(false);
    } finally {
      restoreChatGptWebHome(savedHome, home);
    }
  });
});
