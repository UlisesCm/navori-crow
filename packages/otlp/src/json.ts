import type { OtlpJson } from "./types";

/** The body is not valid JSON or not a JSON object. Maps to HTTP 400. */
export class OtlpJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpJsonError";
  }
}

/**
 * Parses an OTLP/JSON body. The spec's quirks (int64 and `*UnixNano` as
 * decimal strings, ids as hex, enums as int or name) need no rewriting here:
 * the flattener reads them as sent. An empty body is a valid empty request.
 */
export function parseOtlpJson(text: string): OtlpJson {
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OtlpJsonError("body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OtlpJsonError("body is not a JSON object");
  }
  return parsed as OtlpJson;
}
