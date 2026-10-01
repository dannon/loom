/** C1 caps a signature at 200 characters. */
export declare const SIGNATURE_MAX: 200;

/** What a signature normalizes to when nothing usable is left. */
export declare const UNKNOWN_SIGNATURE: "unknown";

/**
 * One error or outcome -> one stable, identifier-free signature. Replacement
 * order is contractual: `<url>`, `<email>`, `<path>`, `<id>` (16+ hex), `<n>`
 * (5+ digits), then truncate to 200. Returns "unknown" when nothing is left.
 */
export declare function normalizeSignature(text: unknown): string;
