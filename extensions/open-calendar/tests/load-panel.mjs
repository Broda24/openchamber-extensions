// Loads the pure functions straight from the shipped panel/main.js, so the tests
// always exercise the maintained bundle and never a copy that could drift.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../panel/main.js', import.meta.url), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`Abschnitt ${from} nicht gefunden.`);
  return source.slice(start, end);
}

// The UI helpers live in panel/main.ts next to DOM code; take only these declarations.
function mainFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`, source.indexOf('// panel/main.ts'));
  if (start < 0) throw new Error(`Funktion ${name} nicht gefunden.`);
  const end = source.slice(start + 1).search(/\n {2}(?:async function|function|var) /);
  return source.slice(start, start + 1 + end);
}

const exported = [
  'addDays', 'draftEvent', 'eventFormFields', 'eventsOnDay', 'filterEvents', 'formatTimeRange', 'listAnswer',
  'parseIcs', 'parseIntent', 'resolveDelete', 'resolveUpdate', 'timedSegment', 'validateEvent', 'createCalendarStorage',
];
const body = [
  section('// panel/model.ts', '// panel/main.ts'),
  ...['dayCountOfMonth', 'minutesInZone', 'timedSegment'].map(mainFunction),
  `return { ${exported.join(', ')} };`,
].join('\n');

export const calendar = new Function(body)();
