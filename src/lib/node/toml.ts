/**
 * Minimal TOML emitter / parser tuned for the per-service draft payloads
 * defined in `decisions/node-field-catalog.md`.
 *
 * Why hand-written: the wire-format regression tests target an exact
 * output shape (predictable ordering, fixed quoting, known formatting
 * per value type) so the emitter can later be cross-checked against
 * captured aice-web payloads without library-induced cosmetic diffs.
 * Our payloads are flat `key = value` records with no nested tables
 * — the surface area is small enough that controlling every byte
 * beats wrestling with a third-party library's defaults.
 *
 * Supported value types:
 *   - string  → `"…"` (basic strings; backslashes and quotes escaped)
 *   - number  → integer literal
 *   - boolean → `true` / `false`
 *   - array of (string | number) → `["a", "b"]` / `[1, 2]`
 *
 * `null` / `undefined` values are skipped (Rust `Option::None` →
 * absent key).
 */

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | readonly TomlScalar[] | null | undefined;
export type TomlEntries = readonly (readonly [string, TomlValue])[];

/**
 * Emit a flat TOML document. Entries are written in argument order;
 * skipped entries (`null` / `undefined`) leave no trace, matching
 * Rust's default `Option<T>` serialisation. The output ends with a
 * trailing newline to match `toml::to_string`'s output.
 */
export function toToml(entries: TomlEntries): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    lines.push(`${key} = ${formatValue(value)}`);
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function formatValue(value: TomlScalar | readonly TomlScalar[]): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map(formatScalar).join(", ")}]`;
  }
  return formatScalar(value as TomlScalar);
}

function formatScalar(value: TomlScalar): string {
  if (typeof value === "string") return formatString(value);
  if (typeof value === "number") return formatNumber(value);
  return value ? "true" : "false";
}

function formatString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20)
      out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
    else out += ch;
  }
  out += '"';
  return out;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value))
    throw new Error(`Cannot serialise non-finite number to TOML: ${value}`);
  if (!Number.isInteger(value))
    throw new Error(
      `Only integer numbers are supported by this TOML emitter; got ${value}`,
    );
  return String(value);
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the flat TOML documents this module emits. Comments and inline
 * whitespace are tolerated; nested tables and inline tables are not
 * (none of our service drafts use them).
 */
export function fromToml(
  text: string,
): Record<string, TomlScalar | TomlScalar[]> {
  const out: Record<string, TomlScalar | TomlScalar[]> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.replace(/\s*#.*$/, "").trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("[")) {
      throw new Error(
        `TOML tables are not supported by this parser at line ${i + 1}: ${raw}`,
      );
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      throw new Error(`Malformed TOML line ${i + 1}: ${raw}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = parseValue(value, i + 1);
  }
  return out;
}

function parseValue(input: string, line: number): TomlScalar | TomlScalar[] {
  if (input.length === 0) {
    throw new Error(`Empty TOML value at line ${line}`);
  }
  if (input.startsWith("[")) return parseArray(input, line);
  if (input.startsWith('"')) return parseString(input, line);
  if (input === "true") return true;
  if (input === "false") return false;
  return parseInteger(input, line);
}

function parseArray(input: string, line: number): TomlScalar[] {
  if (!input.endsWith("]")) {
    throw new Error(`Unterminated TOML array at line ${line}: ${input}`);
  }
  const inner = input.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items: TomlScalar[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i] ?? "")) i += 1;
    if (i >= inner.length) break;
    const ch = inner[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < inner.length) {
        const c = inner[end];
        if (c === "\\") {
          end += 2;
          continue;
        }
        if (c === '"') break;
        end += 1;
      }
      if (inner[end] !== '"') {
        throw new Error(`Unterminated string in array at line ${line}`);
      }
      items.push(parseString(inner.slice(i, end + 1), line));
      i = end + 1;
    } else {
      let end = i;
      while (end < inner.length && inner[end] !== ",") end += 1;
      const token = inner.slice(i, end).trim();
      items.push(parseInteger(token, line));
      i = end;
    }
    while (i < inner.length && /\s/.test(inner[i] ?? "")) i += 1;
    if (inner[i] === ",") i += 1;
  }
  return items;
}

function parseString(input: string, line: number): string {
  if (!input.startsWith('"') || !input.endsWith('"') || input.length < 2) {
    throw new Error(`Malformed TOML string at line ${line}: ${input}`);
  }
  const body = input.slice(1, -1);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === "\\") out += "\\";
      else if (next === '"') out += '"';
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "b") out += "\b";
      else if (next === "f") out += "\f";
      else if (next === "u") {
        const hex = body.slice(i + 2, i + 6);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      } else {
        throw new Error(`Unknown TOML escape \\${next ?? ""} at line ${line}`);
      }
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function parseInteger(token: string, line: number): number {
  if (!/^-?\d+$/.test(token)) {
    throw new Error(`Expected integer at line ${line}: ${token}`);
  }
  return Number(token);
}
