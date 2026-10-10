/**
 * Provider/account binding identity (architecture §6.2, §7).
 *
 * A binding is *identity*, never a credential: it is derived from the provider id and the account
 * fingerprint the driver established, plus the browser profile/context the transport uses. Two
 * accounts of the same provider are two bindings, so one host session can hold one conversation per
 * account and per provider without any of them reusing another's handle.
 *
 * This module has no provider knowledge and no runtime dependency.
 */
import { createHash } from "node:crypto";
import type { WebChatAccountBinding } from "./conversation";

/** Opaque, stable identity of one provider/account binding. */
export type WebChatAccountBindingId = string & {
  readonly __webChatAccountBindingId: unique symbol;
};

/**
 * Derive the binding identity of one authenticated account.
 *
 * @param binding - the provider, account fingerprint and optional browser profile/context.
 * @returns the stable binding id.
 * @throws {TypeError} when the binding carries no provider or account fingerprint.
 */
export function webChatAccountBindingId(binding: WebChatAccountBinding): WebChatAccountBindingId {
  if (typeof binding.providerId !== "string" || binding.providerId.length === 0) {
    throw new TypeError("WebChat account binding requires a provider identity");
  }
  if (typeof binding.accountFingerprint !== "string" || binding.accountFingerprint.length === 0) {
    throw new TypeError("WebChat account binding requires an account fingerprint");
  }
  return createHash("sha256").update(JSON.stringify({
    providerId: binding.providerId,
    accountFingerprint: binding.accountFingerprint,
    browserProfile: binding.browserProfile ?? "",
    browserContext: binding.browserContext ?? "",
  })).digest("hex") as WebChatAccountBindingId;
}
