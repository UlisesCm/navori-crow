export type OtelSignal = "log" | "span" | "metric";

/** OTLP/JSON shape: what both the JSON body and the protobuf decoder produce. */
export type OtlpJson = { [key: string]: OtlpJsonValue };
export type OtlpJsonValue = string | number | boolean | null | OtlpJsonValue[] | OtlpJson;

export type OtlpSignal = "logs" | "traces" | "metrics";
