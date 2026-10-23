// A deliberately tiny YAML subset: just enough to write `outline.yaml` / `fields.yaml` in readable block
// style and read them back. The project forbids a YAML dependency (boundary rule B2), and the files are
// OSA's own, so the grammar is OSA's too:
//   - maps (`key: value`), lists (`- item`), nesting by 2-space indentation;
//   - every string scalar is written JSON-quoted (valid YAML double-quoted), so no quoting ambiguity;
//   - numbers, booleans, null bare; empty list `[]`, empty map `{}`.
// `fromYaml(toYaml(x))` equals `x` for any JSON data. Hand-edits within this grammar are accepted; anything
// else is a loud error rather than a guess.

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`toYaml: unsupported scalar ${typeof v}`);
}

function key(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : JSON.stringify(k);
}

function emit(value: unknown, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const el of value as unknown[]) {
      if (isScalar(el)) {
        out.push(`${pad}- ${scalar(el)}`);
      } else if (Array.isArray(el) ? el.length === 0 : Object.keys(el as object).length === 0) {
        out.push(`${pad}- ${Array.isArray(el) ? "[]" : "{}"}`);
      } else {
        // Compact form: the first line of the nested block rides on the dash line.
        const nested: string[] = [];
        emit(el, indent + 2, nested);
        out.push(`${pad}- ${(nested[0] ?? "").trimStart()}`);
        out.push(...nested.slice(1));
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isScalar(v)) {
      out.push(`${pad}${key(k)}: ${scalar(v)}`);
    } else if (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0) {
      out.push(`${pad}${key(k)}: ${Array.isArray(v) ? "[]" : "{}"}`);
    } else {
      out.push(`${pad}${key(k)}:`);
      emit(v, indent + 2, out);
    }
  }
}

/** Serialises JSON-compatible data as block-style YAML (trailing newline included). */
export function toYaml(value: unknown): string {
  if (isScalar(value)) return `${scalar(value)}\n`;
  const out: string[] = [];
  emit(value, 0, out);
  return out.join("\n") + "\n";
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function parseScalar(raw: string, no: number): unknown {
  const t = raw.trim();
  if (t === "null" || t === "~" || t === "") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "[]") return [];
  if (t === "{}") return {};
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(`YAML line ${String(no)}: bad quoted string: ${t}`);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // Unquoted text is accepted for hand edits, as a plain string.
  return t;
}

/** Splits `key: rest` honouring a JSON-quoted key. Returns null if the text is not a map entry. */
function splitEntry(text: string): { k: string; rest: string } | null {
  if (text.startsWith('"')) {
    const m = text.match(/^("(?:[^"\\]|\\.)*")\s*:(?:\s+(.*))?$/);
    if (m?.[1] === undefined) return null;
    return { k: JSON.parse(m[1]) as string, rest: m[2] ?? "" };
  }
  const m = text.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/);
  return m?.[1] === undefined ? null : { k: m[1], rest: m[2] ?? "" };
}

function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  const first = lines[start];
  if (first === undefined) return [null, start];
  const isList = first.text === "-" || first.text.startsWith("- ");
  let i = start;
  if (isList) {
    const list: unknown[] = [];
    while (i < lines.length) {
      const ln = lines[i] as Line;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new Error(`YAML line ${String(ln.no)}: unexpected indentation`);
      if (!(ln.text === "-" || ln.text.startsWith("- "))) break;
      const rest = ln.text === "-" ? "" : ln.text.slice(2);
      if (rest === "") {
        const next = lines[i + 1];
        if (next !== undefined && next.indent > indent) {
          const [v, ni] = parseBlock(lines, i + 1, next.indent);
          list.push(v);
          i = ni;
        } else {
          list.push(null);
          i += 1;
        }
      } else if (splitEntry(rest) !== null || rest === "-" || rest.startsWith("- ")) {
        // `- key: value` / `- - x`: re-seat the remainder as a block two columns deeper.
        const virtual: Line = { indent: indent + 2, text: rest, no: ln.no };
        const sub = [virtual, ...lines.slice(i + 1)];
        const [v, consumed] = parseBlock(sub, 0, indent + 2);
        list.push(v);
        i += consumed;
      } else {
        list.push(parseScalar(rest, ln.no));
        i += 1;
      }
    }
    return [list, i];
  }
  const map: Record<string, unknown> = {};
  while (i < lines.length) {
    const ln = lines[i] as Line;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new Error(`YAML line ${String(ln.no)}: unexpected indentation`);
    const entry = splitEntry(ln.text);
    if (entry === null) {
      if (ln.text.startsWith("- ")) break;
      throw new Error(`YAML line ${String(ln.no)}: expected "key: value", got: ${ln.text}`);
    }
    if (entry.rest !== "") {
      map[entry.k] = parseScalar(entry.rest, ln.no);
      i += 1;
    } else {
      const next = lines[i + 1];
      if (next !== undefined && next.indent > indent) {
        const [v, ni] = parseBlock(lines, i + 1, next.indent);
        map[entry.k] = v;
        i = ni;
      } else if (next !== undefined && next.indent === indent && (next.text === "-" || next.text.startsWith("- "))) {
        // YAML allows a list at the same indent as its key.
        const [v, ni] = parseBlock(lines, i + 1, indent);
        map[entry.k] = v;
        i = ni;
      } else {
        map[entry.k] = null;
        i += 1;
      }
    }
  }
  return [map, i];
}

/** Parses the subset {@link toYaml} writes (plus plain unquoted scalars and comments). Throws on anything else. */
export function fromYaml(text: string): unknown {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) return;
    if (/^\t/.test(raw)) throw new Error(`YAML line ${String(idx + 1)}: tabs are not allowed`);
    lines.push({ indent: raw.length - raw.trimStart().length, text: raw.trim(), no: idx + 1 });
  });
  if (lines.length === 0) return null;
  const first = lines[0] as Line;
  if (!(first.text === "-" || first.text.startsWith("- ") || splitEntry(first.text) !== null)) {
    return parseScalar(first.text, first.no);
  }
  const [value, next] = parseBlock(lines, 0, first.indent);
  if (next < lines.length) {
    const bad = lines[next] as Line;
    throw new Error(`YAML line ${String(bad.no)}: could not parse: ${bad.text}`);
  }
  return value;
}
