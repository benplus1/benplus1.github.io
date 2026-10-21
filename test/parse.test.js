import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseCsv,
  parseClock,
  findSessions,
  parseDose,
  expandRow,
  buildSchedule
} from '../timer/parse.js';

const fixture = readFileSync(new URL('./fixtures/mobility-2026-10-20.csv', import.meta.url), 'utf8');
const header = ['Clock', 'Exercise', 'Dose', 'Link', 'Notes'];
const blank = ['', '', '', '', ''];
const kinds = new Set(['hold', 'reset', 'switch', 'work', 'next', 'rest']);

function fixtureSessions() {
  return findSessions(parseCsv(fixture));
}

function row(dose, overrides = {}) {
  return {
    clock: '0:00-1:00',
    exercise: 'Test',
    dose,
    link: '',
    notes: '',
    slot: 60,
    ...overrides
  };
}

function expand(dose, options = {}) {
  const allocation = { slot: 60, isLast: true, nextName: '', ...options };
  return expandRow(row(dose, { slot: allocation.slot }), allocation);
}

function segmentValues(segments) {
  return segments.map(({ label, seconds, kind }) => [label, seconds, kind]);
}

function assertSegments(segments, expected) {
  assert.deepEqual(segmentValues(segments), expected);
  for (const segment of segments) {
    assert.equal(typeof segment.speech, 'string');
    assert.ok(segment.speech.trim(), `Missing speech for ${segment.label}`);
    assert.ok(kinds.has(segment.kind), `Invalid kind ${segment.kind}`);
    assert.equal(typeof segment.seconds, 'number');
    assert.ok(Number.isFinite(segment.seconds) && segment.seconds > 0);
  }
}

function assertExpansion(result, expected, warnings = []) {
  assertSegments(result.segments, expected.map(([label, seconds, kind]) => [
    label === 'Test' ? 'Test' : `Test — ${label}`, seconds, kind
  ]));
  assert.deepEqual(result.warnings, warnings);
}

function assertDose(text, expected) {
  const result = parseDose(text);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.segments.map(({ label, kind }) => [label, kind]),
    expected.map(([label, , kind]) => [label, kind]));
  expected.forEach(([, seconds], index) => {
    if (seconds !== null) assert.equal(result.segments[index].seconds, seconds);
  });
  return result;
}

function assertOracle(schedule, oracle, total) {
  const expected = oracle.flatMap(([exercise, steps]) => steps.map(([label, seconds, kind]) => [
    label === exercise ? exercise : `${exercise} — ${label}`, seconds, kind
  ]));
  assertSegments(schedule.segments, expected);
  assert.equal(schedule.total, total);
  assert.equal(schedule.segments.reduce((sum, segment) => sum + segment.seconds, 0), total);
  assert.deepEqual(schedule.warnings, []);
}

function assertMetadata(schedule, rows) {
  for (const segment of schedule.segments) {
    assert.ok(Number.isInteger(segment.rowIndex));
    assert.ok(segment.rowIndex >= 0 && segment.rowIndex < rows.length);
    const source = rows[segment.rowIndex];
    assert.ok(segment.label === source.exercise || segment.label.startsWith(`${source.exercise} — `));
    assert.equal(segment.clock, source.clock);
    assert.equal(segment.link, source.link);
    assert.deepEqual(segment.notes, source.notes.split(/\r\n|\r|\n/).filter(line => line.trim()));
  }
  assert.deepEqual([...new Set(schedule.segments.map(segment => segment.rowIndex))],
    rows.map((_, index) => index));
}

const routineOracle = [
  ['Frog rock-backs into hold', [
    ['Hold 1 of 2', 60, 'hold'], ['Reset', 30, 'reset'], ['Hold 2 of 2', 60, 'hold']
  ]],
  ['Couch stretch', [
    ['Left', 60, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 60, 'hold'],
    ['Next: Half-split hamstring stretch', 20, 'next']
  ]],
  ['Half-split hamstring stretch', [
    ['Left', 60, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 60, 'hold'],
    ['Next: 90/90 hip switches and leans', 20, 'next']
  ]],
  ['90/90 hip switches and leans', [
    ['4 switches', 45, 'work'], ['Lean left', 25, 'hold'], ['Switch sides', 10, 'switch'],
    ['Lean right', 25, 'hold'], ['Next: High-step lift-offs', 15, 'next']
  ]],
  ['High-step lift-offs', [
    ['3 x 5 s, left', 15, 'hold'], ['3 x 5 s, right', 15, 'hold']
  ]],
  ['Bench overhead reach, palms up', [
    ['Hold 1 of 2', 60, 'hold'], ['Reset', 15, 'reset'], ['Hold 2 of 2', 60, 'hold'],
    ['3 lift-offs of 2 s', 10, 'work'], ['Next: Doorway chest stretch, arm high', 5, 'next']
  ]],
  ['Doorway chest stretch, arm high', [
    ['Left', 60, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 60, 'hold'],
    ['Next: Cross-body stretch, shoulder blade pinned', 20, 'next']
  ]],
  ['Cross-body stretch, shoulder blade pinned', [
    ['Left', 60, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 60, 'hold'],
    ['Next: Lumbar-locked thoracic rotation', 20, 'next']
  ]],
  ['Lumbar-locked thoracic rotation', [
    ['3 reps per side, left', 22, 'work'], ['3 reps per side, right', 22, 'work'],
    ['Next: Thoracic extension over a rolled towel', 16, 'next']
  ]],
  ['Thoracic extension over a rolled towel', [
    ['Hold 1 of 2', 20, 'hold'], ['Reset', 15, 'reset'], ['Hold 2 of 2', 20, 'hold'],
    ['Next: Wall slides with lift-off', 5, 'next']
  ]],
  ['Wall slides with lift-off', [
    ['6 reps', 45, 'work'], ['Next: Side-lying external rotation', 15, 'next']
  ]],
  ['Side-lying external rotation', [
    ['6 slow reps per side, left', 45, 'work'], ['6 slow reps per side, right', 45, 'work']
  ]]
];

const optionalOracle = [
  ['Wrist-extensor stretch', [
    ['Left', 15, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 15, 'hold'],
    ['Next: Wrist and finger-flexor stretch', 10, 'next']
  ]],
  ['Wrist and finger-flexor stretch', [
    ['Left', 15, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 15, 'hold'],
    ['Next: Tendon glides and thumb opposition', 10, 'next']
  ]],
  ['Tendon glides and thumb opposition', [['3 glide cycles', 30, 'work']]]
];

const splitsOracle = [
  ['Seated pancake', [
    ['Hold 1 of 3', 60, 'hold'], ['Reset', 20, 'reset'], ['Hold 2 of 3', 60, 'hold'],
    ['Reset', 20, 'reset'], ['Hold 3 of 3', 60, 'hold'],
    ['Next: Horse stance or wall straddle', 20, 'next']
  ]],
  ['Horse stance or wall straddle', [
    ['Hold 1 of 3', 60, 'hold'], ['Reset', 20, 'reset'], ['Hold 2 of 3', 60, 'hold'],
    ['Reset', 20, 'reset'], ['Hold 3 of 3', 60, 'hold'], ['Next: Cossack squat', 20, 'next']
  ]],
  ['Cossack squat', [
    ['Set 1, left', 41, 'work'], ['Set 1, right', 41, 'work'],
    ['Set 2, left', 41, 'work'], ['Set 2, right', 41, 'work'], ['Next: Pike', 16, 'next']
  ]],
  ['Pike', [['Hold', 120, 'hold']]],
  ['Couch stretch', [['Left', 60, 'hold'], ['Right', 60, 'hold']]],
  ['Thoracic extension over a rolled towel', [
    ['Hold 1 of 2', 30, 'hold'], ['Hold 2 of 2', 30, 'hold']
  ]],
  ['Bridge, or elevated-hand bridge', [
    ['Hold 1 of 3', 20, 'hold'], ['Rest', 60, 'rest'], ['Hold 2 of 3', 20, 'hold'],
    ['Rest', 60, 'rest'], ['Hold 3 of 3', 20, 'hold'], ['Next: Buffer', 60, 'next']
  ]],
  ['Buffer', [['Buffer', 120, 'work']]]
];

test('parseCsv handles a leading BOM, doubled quotes, commas and embedded CR/LF', () => {
  assert.deepEqual(parseCsv('\uFEFFClock,Exercise,Dose,Link,Notes\r\n' +
    '0:00-1:00,"Reach, palms up","2 x 20 s\nthen 3 reps",,"Say ""easy""\r\nRibs down\rBreathe"\r\n'), [
    header,
    ['0:00-1:00', 'Reach, palms up', '2 x 20 s\nthen 3 reps', '',
      'Say "easy"\r\nRibs down\rBreathe']
  ]);
});

test('parseCsv accepts LF and CRLF rows without adding an empty trailing row', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const ending of ['', newline]) {
      assert.deepEqual(parseCsv(`a,b,${newline}c,,d${ending}`), [
        ['a', 'b', ''], ['c', '', 'd']
      ]);
    }
  }
  assert.deepEqual(parseCsv('a,b\n\nc,d\n'), [['a', 'b'], [''], ['c', 'd']]);
  assert.deepEqual(parseCsv('"",,""\n'), [['', '', '']]);
  assert.deepEqual(parseCsv('a,\uFEFFb'), [['a', '\uFEFFb']]);
});

for (const [description, text] of [
  ['an unmatched opening quote', 'a,"unfinished'],
  ['an unmatched quote across rows', 'a,"unfinished\r\nstill unfinished'],
  ['an escaped quote without a closing quote', '"a""'],
  ['a quote inside an unquoted field', 'a,b"c'],
  ['a quoted field following unquoted spaces', 'a, "b"'],
  ['text after a closing quote', 'a,"b"junk,c'],
  ['another quoted field without a delimiter', '"a""b"c']
]) {
  test(`parseCsv rejects ${description} with an informative error`, () => {
    assert.throws(() => parseCsv(text), /csv|quot|field|unexpected|invalid/i);
  });
}

for (const [text, start, end] of [
  ['0:00-2:30', 0, 150],
  ['7:30-9:30', 450, 570],
  ['0-4 min', 0, 240],
  ['20-22 min', 1200, 1320]
]) {
  test(`parseClock parses ${text} in numeric seconds`, () => {
    assert.deepEqual(parseClock(text), { start, end, seconds: end - start });
  });
}

test('parseClock returns null for optional labels and malformed ranges', () => {
  for (const text of [
    'After climbing, optional', '', 'soon', '0:00', '0-4', '4-0 min',
    '0-2:30', '0:00-2 min', '0:00-2', '1:5-2:30', '0:60-2:30',
    '2:30-1:00', '-1-4 min', '0:00-2:30 extra', '0-4 min extra'
  ]) {
    assert.equal(parseClock(text), null, text);
  }
});

test('findSessions discovers the two fixture sessions and preserves source cells', () => {
  const sessions = fixtureSessions();
  assert.deepEqual(sessions.map(session => session.name), [
    'The 22-minute routine (Mon, Wed, Sat)', 'Weekly splits session (Thu evening, 22 min)'
  ]);
  assert.deepEqual(sessions.map(session => session.rows.length), [12, 8]);
  const [routine, splits] = sessions;
  assert.deepEqual(routine.optional.map(group => [group.label, group.rows.length]), [
    ['After climbing, optional', 3]
  ]);
  assert.deepEqual(splits.optional, []);
  assert.deepEqual(routine.rows[0], {
    clock: '0:00-2:30',
    exercise: 'Frog rock-backs into hold',
    dose: '2 x 60 s, 30 s reset',
    link: 'https://youtu.be/orMZYFWo9P0',
    notes: 'Adductors\nLow back flat\nKnees over ankles\nGroin pinch = narrow the knees',
    slot: 150
  });
  assert.equal(routine.rows[3].dose, '4 switches\n25 s lean per side');
  assert.equal(routine.rows[5].exercise, 'Bench overhead reach, palms up');
  assert.equal(routine.optional[0].rows[2].dose, '3 glide cycles\n5 s thumb');
  for (const session of sessions) {
    for (const source of session.rows) {
      assert.equal(typeof source.slot, 'number');
      assert.equal(source.slot, parseClock(source.clock).seconds);
    }
    for (const group of session.optional) {
      for (const source of group.rows) assert.equal(source.slot, null);
    }
  }
});

test('findSessions uses the nearest prior nonempty A cell and stops at an empty A-E row', () => {
  const sessions = findSessions([
    ['Earlier prose', '', '', '', ''], ['Routine A', '', '', '', ''], blank,
    header, ['0:00-1:00', 'First', '30 s', '', ''], blank,
    ['Routine B', '', '', '', ''], header, ['0-4 min', 'Second', '2 min', '', ''], blank,
    ['Trailing prose', '', '', '', '']
  ]);
  assert.deepEqual(sessions.map(session => [session.name, session.rows.map(source => source.exercise)]), [
    ['Routine A', ['First']], ['Routine B', ['Second']]
  ]);
});

test('findSessions groups only consecutive optional rows with the same Clock text', () => {
  const [session] = findSessions([
    ['Routine', '', '', '', ''], header, ['0:00-1:00', 'Main', '30 s', '', ''],
    ['Optional A', 'One', '3 reps', '', ''], ['Optional A', 'Two', '3 reps', '', ''],
    ['Optional B', 'Three', '3 reps', '', ''], ['Optional A', 'Four', '3 reps', '', ''], blank
  ]);
  assert.equal(session.rows.length, 1);
  assert.deepEqual(session.optional.map(group => [group.label, group.rows.map(source => source.exercise)]), [
    ['Optional A', ['One', 'Two']], ['Optional B', ['Three']], ['Optional A', ['Four']]
  ]);
  assert.ok(session.optional.every(group => group.rows.every(source => source.slot === null)));
});

test('findSessions rejects sheets without exact Clock and Exercise header cells', () => {
  for (const cells of [
    ['clock', 'Exercise', 'Dose', 'Link', 'Notes'],
    ['Clock', 'exercise', 'Dose', 'Link', 'Notes'],
    ['Exercise', 'Clock', 'Dose', 'Link', 'Notes'],
    ['Clock ', 'Exercise', 'Dose', 'Link', 'Notes'],
    ['Other', 'Clock', 'Exercise', 'Dose', 'Notes']
  ]) {
    assert.throws(() => findSessions([
      ['Routine', '', '', '', ''], cells, ['0:00-1:00', 'Test', '30 s', '', '']
    ]), /header|clock|exercise|sheet/i);
  }
  assert.throws(() => findSessions([]), /header|sheet|session/i);
  assert.throws(() => findSessions([['Prose only', '', '', '', '']]), /header|sheet|session/i);
});

test('findSessions requires a nonempty session banner and exercise', () => {
  for (const prefix of [[], [blank], [['', 'Not a banner in A', '', '', '']]]) {
    assert.throws(() => findSessions([...prefix, header, ['0:00-1:00', 'Test', '', '', '']]),
      /banner|session|name/i);
  }
  for (const clock of ['0:00-1:00', 'After climbing, optional']) {
    assert.throws(() => findSessions([
      ['Routine', '', '', '', ''], header, [clock, '', '30 s', '', '']
    ]), /exercise|row/i);
  }
});

test('findSessions ignores an empty sixth cell and extra whitespace cells in data rows', () => {
  const valid = [
    ['Routine', '', '', '', ''], header,
    ['0:00-1:00', 'Test', '30 s', 'https://example.com/demo', 'First cue\nSecond cue']
  ];
  const expected = findSessions(valid);
  for (const extra of [[''], [' \t\r\n '], ['', ' \t', '\n']]) {
    assert.deepEqual(findSessions([...valid.slice(0, 2), [...valid[2], ...extra]]), expected);
  }
});

test('findSessions ignores extra empty or whitespace cells in every row type', () => {
  const valid = [
    ['Routine', '', '', '', ''], header, ['0:00-1:00', 'Test', '30 s', '', ''],
    ['After climbing, optional', 'Wrist stretch', '15 s', '', ''], blank,
    ['Second routine', '', '', '', ''], header, ['0:00-1:00', 'Second', '30 s', '', '']
  ];
  const expected = findSessions(valid);
  for (const index of [0, 1, 2, 3, 4]) {
    for (const extra of [[''], [' \t\r\n '], ['', ' \t', '', '\n']]) {
      const padded = valid.map((cells, rowIndex) => rowIndex === index ? [...cells, ...extra] : cells);
      assert.deepEqual(findSessions(padded), expected, `Sheet row ${index + 1}`);
    }
  }
});

for (const [description, extra] of [
  ['an added empty column', ['']],
  ['added whitespace columns', [' \t', '\n', ' \r\n ']]
]) {
  test(`findSessions ignores ${description} across the fixture`, () => {
    const rows = parseCsv(fixture);
    assert.deepEqual(findSessions(rows.map(cells => [...cells, ...extra])), findSessions(rows));
  });
}

test('findSessions rejects content beyond E in every row type with the exact Sheet row', () => {
  const valid = [
    ['Routine', '', '', '', ''], header, ['0:00-1:00', 'Test', '30 s', '', ''],
    ['After climbing, optional', 'Wrist stretch', '15 s', '', ''], blank
  ];
  for (const index of [0, 1, 2, 3, 4]) {
    for (const extra of [['x'], ['', 'extra'], [' \t', ' \r\n', 'extra'], ['', '', '', 'extra']]) {
      const malformed = valid.map((cells, rowIndex) => rowIndex === index ? [...cells, ...extra] : cells);
      assert.throws(() => findSessions(malformed), {
        name: 'Error', message: new RegExp(`^Sheet row ${index + 1}\\b.*beyond column E`)
      });
    }
  }
});

test('findSessions requires five columns A-E in nonempty banners, headers and data rows', () => {
  const valid = [
    ['Routine', '', '', '', ''], header, ['0:00-1:00', 'Test', '30 s', '', ''],
    ['After climbing, optional', 'Wrist stretch', '15 s', '', '']
  ];
  for (const index of [0, 1, 2, 3]) {
    for (const count of [1, 2, 3, 4]) {
      const malformed = valid.map(cells => [...cells]);
      malformed[index] = malformed[index].slice(0, count);
      assert.throws(() => findSessions(malformed), {
        name: 'Error', message: new RegExp(`^Sheet row ${index + 1}\\b.*five required columns A-E`)
      });
    }
  }
});

test('findSessions allows nonzero shorter blank separators and rejects zero-column rows', () => {
  const first = [['Routine', '', '', '', ''], header, ['0:00-1:00', 'Test', '30 s', '', '']];
  const second = [['Second routine', '', '', '', ''], header, ['0:00-1:00', 'Second', '30 s', '', '']];
  const expected = findSessions([...first, blank, ...second]);
  for (const count of [1, 2, 3, 4]) {
    for (const cell of ['', ' \t\r\n ']) {
      assert.deepEqual(findSessions([...first, Array(count).fill(cell), ...second]), expected);
    }
  }
  assert.throws(() => findSessions([...first, [], ...second]), /Sheet row 4\b.*column/);
});

test('parseDose recognizes repeated holds, default resets and explicit reset/rest lengths', () => {
  assertDose('2 x 60 s', [
    ['Hold 1 of 2', 60, 'hold'], ['Reset', null, 'reset'], ['Hold 2 of 2', 60, 'hold']
  ]);
  for (const reset of ['reset', 'resets']) {
    assertDose(`2 x 60 s, 30 s ${reset}`, [
      ['Hold 1 of 2', 60, 'hold'], ['Reset', 30, 'reset'], ['Hold 2 of 2', 60, 'hold']
    ]);
  }
  assertDose('3 x 15-20 s, 60 s rest', [
    ['Hold 1 of 3', 20, 'hold'], ['Rest', 60, 'rest'], ['Hold 2 of 3', 20, 'hold'],
    ['Rest', 60, 'rest'], ['Hold 3 of 3', 20, 'hold']
  ]);
});

for (const dose of [
  '2 x 20 s / 2 x 30 s / 10 s reset',
  '10 s reset / 2 x 20 s / 2 x 30 s'
]) {
  test(`parseDose applies row reset configuration to every hold set: ${dose}`, () => {
    assertDose(dose, [
      ['Hold 1 of 2', 20, 'hold'], ['Reset', 10, 'reset'], ['Hold 2 of 2', 20, 'hold'],
      ['Hold 1 of 2', 30, 'hold'], ['Reset', 10, 'reset'], ['Hold 2 of 2', 30, 'hold']
    ]);
  });
}

for (const dose of ['30 s reset', '30 s rest']) {
  test(`parseDose emits no standalone segment for configuration-only dose: ${dose}`, () => {
    assertDose(dose, []);
  });
}

test('parseDose does not append a rest configuration clause to a single hold', () => {
  assertDose('20 s / 30 s rest', [['Hold', 20, 'hold']]);
});

for (const dose of ['', ' \t\r\n ']) {
  test(`parseDose returns one untimed work placeholder for empty dose ${JSON.stringify(dose)}`, () => {
    const result = assertDose(dose, [['', null, 'work']]);
    assert.equal(result.segments[0].seconds, null);
  });
}

test('parseDose emits no segment or warning for a modifier-only dose', () => {
  assertDose('5 s pause', []);
});

test('parseDose merges short holds and uses the upper end of timed ranges', () => {
  assertDose('3 x 5 s', [['3 x 5 s', 15, 'hold']]);
  assertDose('3 x 4-5 s per side', [
    ['3 x 5 s, left', 15, 'hold'], ['Switch sides', null, 'switch'],
    ['3 x 5 s, right', 15, 'hold']
  ]);
  assertDose('2 x 10 s', [
    ['Hold 1 of 2', 10, 'hold'], ['Reset', null, 'reset'], ['Hold 2 of 2', 10, 'hold']
  ]);
  assertDose('15-20 s', [['Hold', 20, 'hold']]);
});

test('parseDose keeps repeated per-side holds timed and marks the sides', () => {
  const result = parseDose('2 x 20 s per side');
  const holds = result.segments.filter(segment => segment.kind === 'hold');
  assert.equal(holds.length, 4);
  assert.ok(holds.every(segment => segment.seconds === 20));
  assert.equal(holds.filter(segment => /left/i.test(segment.label)).length, 2);
  assert.equal(holds.filter(segment => /right/i.test(segment.label)).length, 2);
  assert.equal(result.segments.filter(segment => segment.kind === 'switch').length, 1);
  assert.deepEqual(result.warnings, []);
});

test('parseDose makes untimed sets and interleaves per-side sets without a switch', () => {
  assertDose('2 x 5', [['Set 1', null, 'work'], ['Set 2', null, 'work']]);
  assertDose('2 x 5 per side', [
    ['Set 1, left', null, 'work'], ['Set 1, right', null, 'work'],
    ['Set 2, left', null, 'work'], ['Set 2, right', null, 'work']
  ]);
});

test('parseDose recognizes minutes, plain holds, named holds and per-side leans', () => {
  assertDose('2 min', [['Hold', 120, 'hold']]);
  assertDose('20 s', [['Hold', 20, 'hold']]);
  assertDose('20 s stretch', [['Stretch', 20, 'hold']]);
  assertDose('60 s per side', [
    ['Left', 60, 'hold'], ['Switch sides', null, 'switch'], ['Right', 60, 'hold']
  ]);
  assertDose('25 s lean per side', [
    ['Lean left', 25, 'hold'], ['Switch sides', null, 'switch'], ['Lean right', 25, 'hold']
  ]);
});

test('parseDose splits all clause separators, strips then and matches case-insensitively', () => {
  for (const separator of [' / ', ', ', '; ', '\n', '\r\n']) {
    assertDose(`20 s${separator}then 3 reps`, [
      ['Hold', 20, 'hold'], ['3 reps', null, 'work']
    ]);
  }
  assertDose('2 X 60 S, 30 S RESETS', [
    ['Hold 1 of 2', 60, 'hold'], ['Reset', 30, 'reset'], ['Hold 2 of 2', 60, 'hold']
  ]);
  assertDose('60 S PER SIDE', [
    ['Left', 60, 'hold'], ['Switch sides', null, 'switch'], ['Right', 60, 'hold']
  ]);
});

test('parseDose treats tempo, pause, lift-off, thumb and hold clauses as modifiers', () => {
  for (const modifier of ['pause', 'up', 'down', 'lift-off', 'lift-offs', 'thumb', 'hold']) {
    assertDose(`6 reps, 3 s ${modifier}`, [['6 reps', null, 'work']]);
  }
  assertDose('3 lift-offs of 2 s', [['3 lift-offs of 2 s', null, 'work']]);
  assertDose('6 slow reps per side, 3 s up, 3 s down', [
    ['6 slow reps per side, left', null, 'work'], ['6 slow reps per side, right', null, 'work']
  ]);
});

test('parseDose preserves number-leading work and warns about unrecognized prose', () => {
  assertDose('4 switches', [['4 switches', null, 'work']]);
  assertDose('3 reps per side', [
    ['3 reps per side, left', null, 'work'], ['3 reps per side, right', null, 'work']
  ]);
  const result = parseDose('until it releases');
  assert.deepEqual(result.segments.map(({ label, kind }) => [label, kind]), [
    ['until it releases', 'work']
  ]);
  assert.deepEqual(result.warnings, ['Dose not understood: "until it releases"']);
});

test('expandRow allocates unrecognized work and reports the dose warning', () => {
  assertExpansion(expand('until it releases', { slot: 60, isLast: false, nextName: 'Next exercise' }), [
    ['until it releases', 45, 'work'], ['Next: Next exercise', 15, 'next']
  ], ['Dose not understood: "until it releases"']);
});

test('expandRow keeps timed holds over a short slot, drops untimed gaps and warns', () => {
  assertExpansion(expand('2 x 60 s', { slot: 60, isLast: false, nextName: 'Next exercise' }), [
    ['Hold 1 of 2', 60, 'hold'], ['Hold 2 of 2', 60, 'hold']
  ], ['Dose exceeds the slot by 60 s']);
  assertExpansion(expand('2 x 60 s, 30 s reset', { slot: 60 }), [
    ['Hold 1 of 2', 60, 'hold'], ['Reset', 30, 'reset'], ['Hold 2 of 2', 60, 'hold']
  ], ['Dose exceeds the slot by 90 s']);
});

test('expandRow gives work its initial share before switch and Next caps', () => {
  assertExpansion(expand('4 switches\n25 s lean per side', {
    slot: 120, isLast: false, nextName: 'High-step lift-offs'
  }), [
    ['4 switches', 45, 'work'], ['Lean left', 25, 'hold'], ['Switch sides', 10, 'switch'],
    ['Lean right', 25, 'hold'], ['Next: High-step lift-offs', 15, 'next']
  ]);
});

test('expandRow allocates gaps in appearance order and lets Next absorb the remainder', () => {
  assertExpansion(expand('2 x 20 s', { slot: 60, isLast: false, nextName: 'Next exercise' }), [
    ['Hold 1 of 2', 20, 'hold'], ['Reset', 15, 'reset'], ['Hold 2 of 2', 20, 'hold'],
    ['Next: Next exercise', 5, 'next']
  ]);
  assertExpansion(expand('3 reps per side', { slot: 60, isLast: false, nextName: 'Next exercise' }), [
    ['3 reps per side, left', 22, 'work'], ['3 reps per side, right', 22, 'work'],
    ['Next: Next exercise', 16, 'next']
  ]);
  assertExpansion(expand('30 s', { slot: 100, isLast: false, nextName: 'Next exercise' }), [
    ['Hold', 30, 'hold'], ['Next: Next exercise', 70, 'next']
  ]);
});

test('expandRow uses the last work or last gap for leftover seconds without Next', () => {
  assertExpansion(expand('3 reps per side', { slot: 45 }), [
    ['3 reps per side, left', 22, 'work'], ['3 reps per side, right', 23, 'work']
  ]);
  assertExpansion(expand('30 s per side', { slot: 100 }), [
    ['Left', 30, 'hold'], ['Switch sides', 40, 'switch'], ['Right', 30, 'hold']
  ]);
});

test('expandRow divides small slack among work before gaps and drops zero durations', () => {
  assertExpansion(expand('3 reps per side', { slot: 9, isLast: false, nextName: 'Next exercise' }), [
    ['3 reps per side, left', 4, 'work'], ['3 reps per side, right', 4, 'work'],
    ['Next: Next exercise', 1, 'next']
  ]);
  assertExpansion(expand('3 x 5 s per side', { slot: 30, isLast: false, nextName: 'Next exercise' }), [
    ['3 x 5 s, left', 15, 'hold'], ['3 x 5 s, right', 15, 'hold']
  ]);
  assertExpansion(expand('2 min / 3 reps', { slot: 120 }), [['Hold', 120, 'hold']]);
});

test('expandRow adds Rest only when timed segments leave slack with no untimed segment', () => {
  assertExpansion(expand('2 min', { slot: 150 }), [['Hold', 120, 'hold'], ['Rest', 30, 'rest']]);
  assertExpansion(expand('60 s'), [['Hold', 60, 'hold']]);
});

test('expandRow uses the exercise for an empty dose', () => {
  const result = expandRow(row('', { exercise: 'Buffer', slot: 120 }), {
    slot: 120, isLast: true, nextName: ''
  });
  assertSegments(result.segments, [['Buffer', 120, 'work']]);
  assert.equal(result.segments[0].speech, 'Buffer');
  assert.deepEqual(result.warnings, []);
});

for (const [dose, label, kind] of [
  ['', 'Test', 'work'],
  [' \t\r\n ', 'Test', 'work'],
  ['5 s pause', 'Rest', 'rest'],
  ['30 s reset', 'Rest', 'rest'],
  ['30 s rest', 'Rest', 'rest']
]) {
  test(`expandRow distinguishes empty work from modifier/configuration-only rest: ${JSON.stringify(dose)}`, () => {
    assertExpansion(expand(dose, { slot: 60, isLast: true }), [[label, 60, kind]]);
  });
}

test('expandRow uses fixed unclocked work, switch, reset and Next lengths', () => {
  assertExpansion(expand('3 reps per side', { slot: null, isLast: false, nextName: 'Next exercise' }), [
    ['3 reps per side, left', 30, 'work'], ['3 reps per side, right', 30, 'work'],
    ['Next: Next exercise', 10, 'next']
  ]);
  assertExpansion(expand('15 s per side', { slot: null, isLast: false, nextName: 'Next exercise' }), [
    ['Left', 15, 'hold'], ['Switch sides', 10, 'switch'], ['Right', 15, 'hold'],
    ['Next: Next exercise', 10, 'next']
  ]);
  assertExpansion(expand('2 x 20 s', { slot: null }), [
    ['Hold 1 of 2', 20, 'hold'], ['Reset', 15, 'reset'], ['Hold 2 of 2', 20, 'hold']
  ]);
});

test('expandRow gives side, switch and Next segments human speech', () => {
  const result = expandRow(row('60 s per side', { exercise: 'Couch stretch', slot: 150 }), {
    slot: 150, isLast: false, nextName: 'Half-split hamstring stretch'
  });
  assertSegments(result.segments, [
    ['Couch stretch — Left', 60, 'hold'], ['Couch stretch — Switch sides', 10, 'switch'],
    ['Couch stretch — Right', 60, 'hold'],
    ['Couch stretch — Next: Half-split hamstring stretch', 20, 'next']
  ]);
  assert.deepEqual(result.segments.map(segment => segment.speech), [
    'Couch stretch, left', 'Switch sides', 'Couch stretch, right',
    'Next, half-split hamstring stretch'
  ]);
});

test('buildSchedule matches every routine segment in order for exactly 1320 seconds', () => {
  const [routine] = fixtureSessions();
  const schedule = buildSchedule(routine, { includeOptional: false });
  assertOracle(schedule, routineOracle, 1320);
  assertMetadata(schedule, routine.rows);
});

test('buildSchedule matches the optional block alone for exactly 130 seconds', () => {
  const [routine] = fixtureSessions();
  const optionalOnly = { ...routine, rows: [], optional: [routine.optional[0]] };
  const schedule = buildSchedule(optionalOnly, { includeOptional: true });
  assertOracle(schedule, optionalOracle, 130);
  assertMetadata(schedule, routine.optional[0].rows);
});

test('buildSchedule appends optional rows without adding Next to the last main row', () => {
  const [routine] = fixtureSessions();
  const schedule = buildSchedule(routine, { includeOptional: true });
  assertOracle(schedule, [...routineOracle, ...optionalOracle], 1450);
  assertMetadata(schedule, [...routine.rows, ...routine.optional[0].rows]);
  const mainLast = schedule.segments.filter(segment => segment.rowIndex === 11);
  assert.equal(mainLast.at(-1).label,
    'Side-lying external rotation — 6 slow reps per side, right');
  assert.equal(mainLast.at(-1).seconds, 45);
  assert.ok(mainLast.every(segment => segment.kind !== 'next'));
  assert.equal(schedule.segments.find(segment => segment.rowIndex === 12).label,
    'Wrist-extensor stretch — Left');
});

test('buildSchedule matches every splits segment in order for exactly 1320 seconds', () => {
  const [, splits] = fixtureSessions();
  const schedule = buildSchedule(splits, { includeOptional: false });
  assertOracle(schedule, splitsOracle, 1320);
  assertMetadata(schedule, splits.rows);
});

test('buildSchedule ends the splits fixture with a 120-second Buffer work segment', () => {
  const [, splits] = fixtureSessions();
  const schedule = buildSchedule(splits, { includeOptional: false });
  const last = schedule.segments.at(-1);
  assert.equal(last.label, 'Buffer');
  assert.equal(last.speech, 'Buffer');
  assert.equal(last.seconds, 120);
  assert.equal(last.kind, 'work');
});

test('buildSchedule ends each optional group independently', () => {
  const session = {
    name: 'Separate optional groups', rows: [], optional: [
      { label: 'First group', rows: [row('3 reps', { exercise: 'One', slot: null })] },
      { label: 'Second group', rows: [row('3 reps', { exercise: 'Two', slot: null })] }
    ]
  };
  const schedule = buildSchedule(session, { includeOptional: true });
  assertOracle(schedule, [
    ['One', [['3 reps', 30, 'work']]], ['Two', [['3 reps', 30, 'work']]]
  ], 60);
  assert.deepEqual(schedule.segments.map(segment => segment.rowIndex), [0, 1]);
});

test('buildSchedule carries nonempty note lines, clock and link onto every segment', () => {
  const source = row('2 x 20 s', {
    clock: '7:30-8:30', link: 'https://example.com/demo', notes: '\nFirst cue\n\nSecond cue\n'
  });
  const schedule = buildSchedule({ name: 'Notes', rows: [source], optional: [] }, {
    includeOptional: false
  });
  assertMetadata(schedule, [source]);
  for (const segment of schedule.segments) {
    assert.equal(segment.rowIndex, 0);
    assert.equal(segment.clock, '7:30-8:30');
    assert.equal(segment.link, 'https://example.com/demo');
    assert.deepEqual(segment.notes, ['First cue', 'Second cue']);
  }
});

test('buildSchedule propagates warnings and totals the actual overlong duration', () => {
  const session = {
    name: 'Warnings', rows: [row('2 x 60 s', { slot: 60 })], optional: []
  };
  const schedule = buildSchedule(session, { includeOptional: false });
  assertSegments(schedule.segments, [
    ['Test — Hold 1 of 2', 60, 'hold'], ['Test — Hold 2 of 2', 60, 'hold']
  ]);
  assert.equal(schedule.total, 120);
  assert.ok(schedule.warnings.some(warning => warning.includes('Dose exceeds the slot by 60 s')));
});
