// Fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Pure JavaScript/TypeScript source only: no WebAssembly, no native addon,
// no prebuilt binary, no network, no install. Deterministic.
//
// Strategy: the reference reads one character at a time and builds every field
// with `value += c`. This parser instead jumps with native indexOf/slice:
//  - a record whose line holds no quote and no stray CR is split natively;
//  - a plain unquoted field is sliced between the next ',' / '\n' (found by
//    indexOf), with a cached next-'\r' position so no scan ever re-runs;
//  - only quoted fields, stray CRs, quote junk and unterminated quotes take
//    the slow character path, and quoted chunks are sliced between quotes.
// Field values are slices of the input (V8 sliced strings), never rebuilt
// character by character.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  let text = input.text;
  if (typeof text !== 'string') text = String(text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;
  let ended = END;

  // End of the current line (position of its '\n'), or -1 when the text
  // holds no further '\n'. -2 means "not computed yet". pos only moves
  // forward, so a cached value stays valid until pos passes it.
  let lineEnd = -2;

  // Position of the next '\r' at or after pos, or -1 when there is none.
  // -2 means "not computed yet". pos only moves forward, so a cached value
  // stays valid until pos passes it; recomputing then scans each '\r' once.
  let crPos = -2;
  function nextCr() {
    if (crPos === -2 || crPos < pos) crPos = text.indexOf('\r', pos);
    return crPos;
  }

  // Reads an unquoted field the slow way (a stray CR, quote junk, or a
  // re-read after an unterminated quote): keeps segments between the
  // characters that matter, records stray_cr, sets `ended`, returns value.
  function unquotedSlow(value) {
    let seg = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (seg < pos) value += text.slice(seg, pos);
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        if (seg < pos) value += text.slice(seg, pos);
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          if (seg < pos) value += text.slice(seg, pos);
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
          return value;
        }
        if (seg < pos) value += text.slice(seg, pos);
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    if (seg < pos) value += text.slice(seg, pos);
    ended = END;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos. Sets `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return unquotedSlow('"');
      }
      if (q > p) {
        const chunk = text.slice(p, q);
        if (chunk.indexOf('\n') === -1 && chunk.indexOf('\r') === -1) {
          value += chunk;
        } else {
          // Each CRLF or lone CR inside quotes is one LF; each LF is one.
          value += chunk.replace(/\r\n|\r|\n/g, () => {
            line += 1;
            return '\n';
          });
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        p = q + 2;
        continue;
      }
      pos = q + 1;
      if (pos >= n) {
        ended = END;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands.
      const before = value.length;
      const v = unquotedSlow(value);
      if (v.length > before) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return v;
    }
  }

  // Applies a finished record: width, header, short/long row handling.
  // A line that held only stray CRs is left with no characters: no record.
  function finishRecord(fields, lastQuoted) {
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (pos < n) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast record: the line holds no quote, so no field in it is quoted.
    if (lineEnd === -2 || pos > lineEnd) lineEnd = text.indexOf('\n', pos);
    const nlPos = lineEnd;
    const lineEndPos = nlPos === -1 ? n : nlPos;
    const qPos = text.indexOf('"', pos);
    if (qPos === -1 || qPos >= lineEndPos) {
      const cr = nextCr();
      if (cr === -1 || cr >= lineEndPos) {
        // No CR in the line: split it natively.
        finishRecord(text.slice(pos, lineEndPos).split(','), false);
        pos = nlPos === -1 ? n : nlPos + 1;
        if (nlPos !== -1) line += 1;
        continue;
      }
      if (nlPos !== -1 && cr === nlPos - 1) {
        // CRLF: the CR is the line break, not part of a field.
        finishRecord(text.slice(pos, nlPos - 1).split(','), false);
        pos = nlPos + 1;
        line += 1;
        continue;
      }
      // A stray CR sits inside the line: fall through to the slow path.
    }

    // Slow record: field by field.
    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      let value;
      if (lastQuoted) {
        value = readQuoted();
      } else {
        if (lineEnd === -2 || pos > lineEnd) lineEnd = text.indexOf('\n', pos);
        const comma = text.indexOf(',', pos);
        if (comma !== -1 && (lineEnd === -1 || comma < lineEnd)) {
          const cr = nextCr();
          if (cr === -1 || cr >= comma) {
            value = text.slice(pos, comma);
            pos = comma + 1;
            ended = COMMA;
          } else {
            value = unquotedSlow('');
          }
        } else if (lineEnd !== -1) {
          const cr = nextCr();
          if (cr === -1 || cr >= lineEnd) {
            value = text.slice(pos, lineEnd);
            pos = lineEnd + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (cr === lineEnd - 1) {
            value = text.slice(pos, lineEnd - 1);
            pos = lineEnd + 1;
            line += 1;
            ended = LINE_BREAK;
          } else {
            value = unquotedSlow('');
          }
        } else {
          const cr = nextCr();
          if (cr === -1) {
            value = text.slice(pos);
            pos = n;
            ended = END;
          } else {
            value = unquotedSlow('');
          }
        }
      }
      fields.push(value);
    } while (ended === COMMA);
    finishRecord(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
