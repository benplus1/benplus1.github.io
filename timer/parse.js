function requireString(value, name, nonempty = false) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (nonempty && !value.trim()) throw new Error(`${name} must not be empty`);
}

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireSlot(value, name) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a nonnegative number of seconds or null`);
  }
}

export function parseCsv(text) {
  requireString(text, 'CSV text');
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start';

  function fail(message, index) {
    throw new SyntaxError(`CSV row ${rows.length + 1}, field ${row.length + 1}, character ${index + 1}: ${message}`);
  }

  for (let index = text.startsWith('\uFEFF') ? 1 : 0; index < text.length; index++) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          state = 'closed';
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === ',') {
      row.push(field);
      field = '';
      state = 'start';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r') {
        if (text[index + 1] !== '\n') fail('A row-ending CR must be followed by LF', index);
        index++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'start';
    } else if (state === 'closed') {
      fail('Unexpected characters after a closing quote', index);
    } else if (character === '"') {
      if (state !== 'start') fail('Quote inside an unquoted field', index);
      state = 'quoted';
    } else {
      field += character;
      state = 'unquoted';
    }
  }

  if (state === 'quoted') fail('Unclosed quoted field', text.length);
  if (state !== 'start' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseClock(text) {
  requireString(text, 'Clock text');
  const clock = text.trim();
  let start;
  let end;
  if (clock.includes(':')) {
    const match = /^(\d+):([0-5]\d)\s*-\s*(\d+):([0-5]\d)$/.exec(clock);
    if (!match) return null;
    start = Number(match[1]) * 60 + Number(match[2]);
    end = Number(match[3]) * 60 + Number(match[4]);
  } else {
    const match = /^(\d+)\s*-\s*(\d+)\s+min$/i.exec(clock);
    if (!match) return null;
    start = Number(match[1]) * 60;
    end = Number(match[2]) * 60;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
  return { start, end, seconds: end - start };
}

export function findSessions(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Sheet rows must be an array');
  const sessions = [];
  let banner = null;
  let session = null;
  let optionalGroup = null;

  rows.forEach((cells, index) => {
    const context = `Sheet row ${index + 1}`;
    if (!Array.isArray(cells) || cells.some(cell => typeof cell !== 'string')) {
      throw new TypeError(`${context} must be an array of string cells`);
    }
    if (cells.slice(5).some(cell => cell.trim())) {
      throw new Error(`${context} must not have content beyond column E`);
    }
    const empty = cells.every(cell => !cell.trim());
    if (cells.length < 5 && !(empty && cells.length > 0)) {
      throw new Error(`${context} must have five required columns A-E (found ${cells.length})`);
    }
    if (empty) {
      session = null;
      optionalGroup = null;
      return;
    }

    const [clock, exercise, dose, link, notes] = cells;
    const isHeader = clock === 'Clock' && exercise === 'Exercise';
    if (clock.trim().toLowerCase() === 'clock' || exercise.trim().toLowerCase() === 'exercise') {
      if (!isHeader) throw new Error(`${context}: malformed Clock/Exercise header`);
    }
    if (isHeader) {
      if (session) throw new Error(`${context}: session header must follow an empty separator row and banner`);
      if (banner === null) throw new Error(`${context}: missing session banner before Clock/Exercise header`);
      session = { name: banner, rows: [], optional: [] };
      sessions.push(session);
      banner = null;
      optionalGroup = null;
      return;
    }
    if (session === null) {
      if (!clock.trim() || cells.slice(1, 5).some(cell => cell.trim())) {
        throw new Error(`${context}: data requires a session banner and Clock/Exercise header`);
      }
      banner = clock.trim();
      return;
    }
    if (!exercise.trim()) throw new Error(`${context} in "${session.name}": missing exercise`);
    if (!clock.trim()) throw new Error(`${context} in "${session.name}": missing Clock text`);
    const range = parseClock(clock);
    const source = { clock, exercise: exercise.trim(), dose, link, notes, slot: range === null ? null : range.seconds };
    if (range !== null) {
      session.rows.push(source);
      optionalGroup = null;
    } else {
      if (optionalGroup === null || optionalGroup.label !== clock) {
        optionalGroup = { label: clock, rows: [] };
        session.optional.push(optionalGroup);
      }
      optionalGroup.rows.push(source);
    }
  });

  if (sessions.length === 0) throw new Error('Sheet has no Clock/Exercise header');
  for (const found of sessions) {
    if (found.rows.length === 0 && found.optional.length === 0) {
      throw new Error(`Session "${found.name}" has a header but no exercise rows`);
    }
  }
  return sessions;
}

function step(label, seconds, kind) {
  return { label, seconds, kind };
}

function positiveInteger(text, clause) {
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RangeError(`Dose counts and times must be positive safe integers: "${clause}"`);
  }
  return number;
}

function rangeSeconds(lower, upper, clause) {
  const start = positiveInteger(lower, clause);
  const end = upper === undefined ? start : positiveInteger(upper, clause);
  if (end < start) throw new RangeError(`Dose has a reversed time range: "${clause}"`);
  return end;
}

function dosePart(clause, warnings) {
  let match = /^(\d+)\s*x\s*(\d+)(?:\s*-\s*(\d+))?\s*s(?:\s+(per side))?$/i.exec(clause);
  if (match) {
    const count = positiveInteger(match[1], clause);
    const seconds = rangeSeconds(match[2], match[3], clause);
    if (!Number.isSafeInteger(count * seconds)) throw new RangeError(`Dose duration is too large: "${clause}"`);
    return { type: 'holds', count, seconds, perSide: Boolean(match[4]) };
  }
  match = /^(\d+)\s*x\s*(\d+)(?:\s+(per side))?$/i.exec(clause);
  if (match) {
    const count = positiveInteger(match[1], clause);
    positiveInteger(match[2], clause);
    const segments = [];
    for (let index = 1; index <= count; index++) {
      if (match[3]) {
        segments.push(step(`Set ${index}, left`, null, 'work'), step(`Set ${index}, right`, null, 'work'));
      } else {
        segments.push(step(`Set ${index}`, null, 'work'));
      }
    }
    return { type: 'segments', segments };
  }
  match = /^(\d+)\s+min$/i.exec(clause);
  if (match) {
    const seconds = positiveInteger(match[1], clause) * 60;
    if (!Number.isSafeInteger(seconds)) throw new RangeError(`Dose duration is too large: "${clause}"`);
    return { type: 'segments', segments: [step('Hold', seconds, 'hold')] };
  }
  if (/^\d+\s*s\s+(?:pause|up|down|lift-offs?|thumb|hold)$/i.test(clause)) {
    return { type: 'segments', segments: [] };
  }
  match = /^(\d+)\s*s\s+(resets?|rest)$/i.exec(clause);
  if (match) {
    const rest = match[2].toLowerCase() === 'rest';
    return {
      type: 'reset',
      segment: step(rest ? 'Rest' : 'Reset', positiveInteger(match[1], clause), rest ? 'rest' : 'reset')
    };
  }
  match = /^(\d+)(?:\s*-\s*(\d+))?\s*s(?:\s+([a-z]+))?(?:\s+(per side))?$/i.exec(clause);
  if (match) {
    const seconds = rangeSeconds(match[1], match[2], clause);
    const word = match[3] === undefined ? '' : match[3].toLowerCase();
    const label = word ? word[0].toUpperCase() + word.slice(1) : 'Hold';
    const segments = match[4] ? [
      step(word ? `${label} left` : 'Left', seconds, 'hold'),
      step('Switch sides', null, 'switch'),
      step(word ? `${label} right` : 'Right', seconds, 'hold')
    ] : [step(label, seconds, 'hold')];
    return { type: 'segments', segments };
  }
  if (/^\d/.test(clause)) {
    const segments = /\s+per side$/i.test(clause) ? [
      step(`${clause}, left`, null, 'work'), step(`${clause}, right`, null, 'work')
    ] : [step(clause, null, 'work')];
    return { type: 'segments', segments };
  }
  warnings.push(`Dose not understood: "${clause}"`);
  return { type: 'segments', segments: [step(clause, null, 'work')] };
}

function holdSegments(part, reset) {
  const segments = [];
  const sides = part.perSide ? ['left', 'right'] : [''];
  for (const side of sides) {
    if (side === 'right') segments.push(step('Switch sides', null, 'switch'));
    const suffix = side ? `, ${side}` : '';
    if (part.seconds < 10) {
      segments.push(step(`${part.count} x ${part.seconds} s${suffix}`, part.count * part.seconds, 'hold'));
    } else {
      for (let index = 1; index <= part.count; index++) {
        if (index > 1) segments.push({ ...reset });
        const label = part.count === 1 ? 'Hold' : `Hold ${index} of ${part.count}`;
        segments.push(step(`${label}${suffix}`, part.seconds, 'hold'));
      }
    }
  }
  return segments;
}

export function parseDose(text) {
  requireString(text, 'Dose text');
  const warnings = [];
  if (!text.trim()) return { segments: [step('', null, 'work')], warnings };
  const clauses = text.split(/\s+\/\s+|,\s+|;\s+|\r\n|\r|\n/)
    .map(clause => clause.trim().replace(/^then\s+/i, '').trim()).filter(Boolean);
  const parts = clauses.map(clause => dosePart(clause, warnings));
  const resetPart = parts.find(part => part.type === 'reset');
  const reset = resetPart === undefined ? step('Reset', null, 'reset') : resetPart.segment;
  const segments = parts.flatMap(part => {
    if (part.type === 'holds') return holdSegments(part, reset);
    if (part.type === 'reset') return [];
    return part.segments;
  });
  return { segments, warnings };
}

function lowerFirst(text) {
  return text[0].toLowerCase() + text.slice(1);
}

function segmentSpeech(exercise, segment) {
  if (segment.kind === 'next') return `Next, ${lowerFirst(segment.label.slice('Next: '.length))}`;
  if (segment.kind === 'switch' || segment.kind === 'reset' || segment.kind === 'rest') return segment.label;
  return segment.label === exercise ? exercise : `${exercise}, ${lowerFirst(segment.label)}`;
}

export function expandRow(row, options) {
  requireObject(row, 'Exercise row');
  requireString(row.exercise, 'Row exercise', true);
  requireString(row.dose, 'Row dose');
  requireObject(options, 'expandRow options');
  const { slot, isLast, nextName } = options;
  requireSlot(slot, 'expandRow slot');
  if (typeof isLast !== 'boolean') throw new TypeError('expandRow isLast must be a boolean');
  requireString(nextName, 'expandRow nextName', !isLast);

  const parsed = parseDose(row.dose);
  let segments = parsed.segments;
  const warnings = [...parsed.warnings];
  for (const segment of segments) {
    if (segment.kind === 'work' && segment.label === '') segment.label = row.exercise;
  }
  const trailing = isLast ? null : step(`Next: ${nextName}`, null, 'next');
  if (trailing !== null) segments.push(trailing);
  const work = segments.filter(segment => segment.seconds === null && segment.kind === 'work');
  const gaps = segments.filter(segment => segment.seconds === null && segment.kind !== 'work');

  if (slot === null) {
    const durations = { work: 30, switch: 10, reset: 15, next: 10 };
    for (const segment of segments) {
      if (segment.seconds === null) segment.seconds = durations[segment.kind];
    }
  } else {
    const timed = segments.reduce((sum, segment) => sum + (segment.seconds === null ? 0 : segment.seconds), 0);
    let remaining = slot - timed;
    if (remaining < 0) {
      warnings.push(`Dose exceeds the slot by ${-remaining} s`);
      segments = segments.filter(segment => segment.seconds !== null);
    } else {
      const initial = work.length > 0 ? Math.min(10, Math.floor(remaining / work.length)) : 0;
      for (const segment of work) segment.seconds = initial;
      remaining -= initial * work.length;
      const caps = { switch: 10, reset: work.length > 0 ? 10 : 15, next: work.length > 0 ? 5 : 15 };
      for (const gap of gaps) {
        gap.seconds = Math.min(caps[gap.kind], remaining);
        remaining -= gap.seconds;
      }
      if (work.length > 0) {
        const share = Math.floor(remaining / work.length);
        for (const segment of work) segment.seconds += share;
        remaining -= share * work.length;
      }
      if (remaining > 0) {
        const target = trailing !== null ? trailing : work.length > 0 ? work.at(-1) : gaps.at(-1);
        if (target === undefined) segments.push(step('Rest', remaining, 'rest'));
        else target.seconds += remaining;
      }
    }
  }

  segments = segments.filter(segment => segment.seconds > 0);
  if (segments.length === 1 && segments[0].kind === 'hold' && segments[0].label === 'Hold') {
    segments[0].label = row.exercise;
  }

  return {
    segments: segments.map(segment => ({
      label: segment.label === row.exercise ? row.exercise : `${row.exercise} — ${segment.label}`,
      speech: segmentSpeech(row.exercise, segment),
      seconds: segment.seconds,
      kind: segment.kind
    })),
    warnings
  };
}

function requireRows(rows, name) {
  if (!Array.isArray(rows)) throw new TypeError(`${name} must be an array`);
  rows.forEach((row, index) => {
    const context = `${name}[${index}]`;
    requireObject(row, context);
    for (const field of ['clock', 'exercise', 'dose', 'link', 'notes']) {
      requireString(row[field], `${context}.${field}`, field === 'exercise');
    }
    requireSlot(row.slot, `${context}.slot`);
  });
}

export function buildSchedule(session, options) {
  requireObject(session, 'Session');
  requireString(session.name, 'Session name', true);
  requireObject(options, 'buildSchedule options');
  if (typeof options.includeOptional !== 'boolean') {
    throw new TypeError('buildSchedule includeOptional must be a boolean');
  }
  requireRows(session.rows, 'Session rows');
  if (!Array.isArray(session.optional)) throw new TypeError('Session optional groups must be an array');
  session.optional.forEach((group, index) => {
    requireObject(group, `Optional group ${index + 1}`);
    requireString(group.label, `Optional group ${index + 1} label`, true);
    requireRows(group.rows, `Optional group ${index + 1} rows`);
  });

  const groups = [session.rows];
  if (options.includeOptional) groups.push(...session.optional.map(group => group.rows));
  const segments = [];
  const warnings = [];
  let rowIndex = 0;
  for (const rows of groups) {
    rows.forEach((row, index) => {
      const isLast = index === rows.length - 1;
      const expanded = expandRow(row, {
        slot: row.slot, isLast, nextName: isLast ? '' : rows[index + 1].exercise
      });
      for (const segment of expanded.segments) {
        const details = segment.kind === 'next' ? rows[index + 1] : row;
        const notes = details.notes.split(/\r\n|\r|\n/).filter(line => line.trim());
        segments.push({ ...segment, rowIndex, clock: row.clock, link: details.link, notes: [...notes] });
      }
      warnings.push(...expanded.warnings.map(warning => `Row ${rowIndex + 1} (${row.exercise}): ${warning}`));
      rowIndex++;
    });
  }
  return { segments, total: segments.reduce((sum, segment) => sum + segment.seconds, 0), warnings };
}

export function rowStarts(segments) {
  if (!Array.isArray(segments)) throw new TypeError('Schedule segments must be an array');
  const starts = [];
  let elapsed = 0;
  for (const segment of segments) {
    const rowIndex = segment?.rowIndex;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 ||
        (rowIndex !== starts.length - 1 && rowIndex !== starts.length)) {
      throw new RangeError('Segment rowIndex must be a nonnegative integer in contiguous order starting at 0');
    }
    if (rowIndex === starts.length) starts.push(elapsed);
    elapsed += segment.seconds;
  }
  return starts;
}
