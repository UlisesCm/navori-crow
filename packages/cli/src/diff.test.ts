import { describe, expect, test } from "bun:test";
import { formatChangeNotice, maskedDiff } from "./diff";

describe("maskedDiff", () => {
  // Covers: R20
  test("shows a unified diff with context 0", () => {
    const d = maskedDiff('{\n  "a": 1\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n');
    expect(d).toContain("@@");
    expect(d).toContain('+  "b": 2');
  });

  // Covers: R20
  test("a secret never appears: literal token, secret-looking keys, Bearer, extra keys", () => {
    const before =
      '{\n  "env": {\n    "MY_API_KEY": "abc123",\n    "OTHER": "plainvalue"\n  }\n}\n';
    const after =
      '{\n  "env": {\n    "MY_API_KEY": "abc123",\n    "OTHER": "plainvalue",\n    "CROW_TOKEN": "tok-9999",\n    "H": "Authorization: Bearer tok-9999"\n  }\n}\n';
    const d = maskedDiff(before, after, { secrets: ["tok-9999"], maskKeys: ["OTHER"] });
    expect(d).not.toContain("tok-9999");
    expect(d).not.toContain("abc123");
    expect(d).not.toContain("plainvalue");
    expect(d).toContain("***");
  });

  // Covers: R20
  test("masks TOML values too", () => {
    const d = maskedDiff("", 'token = "s3cr3t"\nport = 7777\n');
    expect(d).not.toContain("s3cr3t");
    expect(d).toContain("port = 7777");
  });

  // Covers: R20
  test("Authorization: Bearer value is fully masked", () => {
    const d = maskedDiff("", 'Authorization: Bearer abc123\n"Authorization": "Bearer abc123"\n');
    expect(d).not.toContain("abc123");
  });

  // Covers: R20
  test("multi-line TOML string secrets are masked", () => {
    const d = maskedDiff("", 'password = """\nhunter2-line1\nhunter2-line2\n"""\nport = 1\n');
    expect(d).not.toContain("hunter2");
    expect(d).toContain("port = 1");
  });

  // Covers: R20
  test("argument-array and flag secrets are masked", () => {
    const d = maskedDiff(
      "",
      'args = ["--token","abc123"]\ncmd = "run --api-key=zzz999"\nx = ["--secret", "q"]\n',
    );
    expect(d).not.toContain("abc123");
    expect(d).not.toContain("zzz999");
  });

  // Covers: R20
  test("a known literal secret is masked wherever it appears", () => {
    const d = maskedDiff(
      "",
      'note = "see http://h/?k=lit-secret-42#frag"\nlist = ["lit-secret-42"]\n',
      {
        secrets: ["lit-secret-42"],
      },
    );
    expect(d).not.toContain("lit-secret-42");
  });

  test("identical texts produce an empty diff", () => {
    expect(maskedDiff("a\n", "a\n")).toBe("");
  });
});

describe("formatChangeNotice", () => {
  test("reports lines that change only in format", () => {
    expect(formatChangeNotice('{"a":1,\n"b":[1,2]}')).toMatch(/^\d+ lines change only in format$/);
  });

  test("null when already canonical or not JSON", () => {
    expect(formatChangeNotice('{\n  "a": 1\n}\n')).toBeNull();
    expect(formatChangeNotice("not json")).toBeNull();
  });
});
