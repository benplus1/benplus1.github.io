import { readFile } from 'node:fs/promises';
import { findSessions, parseCsv, spokenCues } from '../../timer/parse.js';

const [source, ...extra] = process.argv.slice(2);
if (!source || extra.length) throw new Error('Usage: node cues.mjs <csv path or URL>');

let csv;
if (/^https?:\/\//i.test(source)) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`CSV request failed: ${response.status} ${response.statusText}`);
  csv = await response.text();
} else {
  csv = await readFile(source, 'utf8');
}
console.log(JSON.stringify(spokenCues(findSessions(parseCsv(csv)))));
