/**
 * The refusal vocabulary of the capture-import pipeline (`src/auth-import.ts`).
 *
 * A capture is supplied by a caller, on the CLI from a file and on the HTTP control surface from a
 * request body. Both entry points run the *same* pipeline, so they must also speak the same machine
 * codes: the CLI turns the message into stderr text, while the control API turns the code plus the
 * message into a 4xx answer. Keeping the vocabulary in one module is what stops the API from growing
 * a second set of refusals beside the pipeline's.
 *
 * Codes are stable and provider-neutral. A provider validator (`provider.accept`) throws an
 * {@link AuthImportRefusal} for its own domain/expiry rules; everything the pipeline itself checks
 * (empty, malformed, wrong shape, predicate failure) uses the same type.
 *
 * Nothing here carries captured material: a refusal names the fix, never a cookie.
 */

/** Every machine code the import pipeline can refuse a caller-supplied capture with. */
export const AUTH_IMPORT_REFUSAL_CODES = {
  /** `provider` is not in the registered import provider list. */
  providerUnknown: "import_provider_unknown",
  /** The request itself is missing a required member or is not an object. */
  invalidRequest: "import_invalid_request",
  /** The capture contains no cookies at all (a truncation or the wrong file). */
  empty: "import_empty",
  /** The body/file is not valid JSON (or is not text at all). */
  malformed: "import_malformed",
  /** JSON, but not a Playwright storage state. */
  shapeInvalid: "import_shape_invalid",
  /** The capture has cookies, but none for the provider's own domains. */
  foreignDomain: "import_foreign_domain",
  /** The provider's own cookies are present but all expired. */
  expired: "import_expired",
  /** The capture's authenticated predicate said it is not a working session. */
  predicateFailed: "import_predicate_failed",
  /** The capture passed the pipeline but could not be written (an operator-side fault). */
  storeFailed: "import_store_failed",
} as const;

/** One stable machine code from {@link AUTH_IMPORT_REFUSAL_CODES}. */
export type AuthImportRefusalCode =
  typeof AUTH_IMPORT_REFUSAL_CODES[keyof typeof AUTH_IMPORT_REFUSAL_CODES];

/**
 * A refused caller-supplied capture.
 *
 * Typed on purpose: the CLI only needs `message`, while the HTTP surface must answer with a 4xx and
 * a machine-readable code instead of collapsing every capture problem into a generic 500.
 *
 * `options.cause` preserves the **provider's own** rejection when the pipeline wraps it. The import
 * message is about the caller's capture ("…so nothing was written"), which is the right sentence for
 * an import and the wrong one for a session check that was never writing anything. Keeping the cause
 * lets the session-health surface report the provider's sentence — through the same
 * `nonSecretDiagnosticText` reducer, never a second one — without duplicating the wrapping policy.
 */
export class AuthImportRefusal extends Error {
  constructor(
    readonly code: AuthImportRefusalCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuthImportRefusal";
  }
}

/** Whether an unknown rejection is an import refusal rather than an operator-side failure. */
export function isAuthImportRefusal(error: unknown): error is AuthImportRefusal {
  return error instanceof AuthImportRefusal;
}
