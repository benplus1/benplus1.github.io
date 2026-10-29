const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsUIH8LDFYsEKvsa0S7FKy5fkKFbA2FDA6a70tyUByPn62Y50gQwVvjdzJbpFCilxERpGecWGZeKEl/pub?gid=900002&single=true&output=csv';

import {parseCsv, findSessions, buildSchedule, rowStarts, changePoints} from './parse.js';

const CSV_KEY = 'mobility-timer:csv';
const VOICE_KEY = 'mobility-timer:voice';
const CHANGES_KEY = 'mobility-timer:changes';
const AUDIO_PAUSED = 'Sound is paused by the browser; tap the page to turn it back on';
const elements = Object.fromEntries([
  'source-status', 'errors', 'warnings', 'offline', 'preparation', 'sessions',
  'optional', 'optional-groups', 'routine', 'session-total', 'start', 'running',
  'countdown', 'segment', 'progress', 'progress-fill', 'timing', 'next', 'notes',
  'demo-line', 'demo', 'ready', 'pause', 'back', 'skip', 'next-row', 'stop', 'finished', 'done-heading',
  'done-total', 'return', 'wake', 'voice', 'changes'
].map(id => [id, document.getElementById(id)]));

const errors = new Map();
const warnings = new Map();
let routineWarnings = [];
const loggedRoutineWarnings = new Set();
let sessions = [];
let selectedSession = 0;
let optionalChoices = new Set();
let schedule = null;
let offsets = [];
let rowOffsets = [];
let rowEnds = new Map();
let segmentLinks = [];
let gates = [];
let crossedChanges = new Set();
let waitingGate = null;
let cachedCopy = null;
let phase = 'preparation';
let startedAt = 0;
let heldElapsed = 0;
let interval = null;
let currentSegment = -1;
let previousRemaining = null;
let soundedTicks = new Set();
let runId = 0;
let voiceOn = true;
let changesMode = 'wait';
let audioContext = null;
const toneNodes = new Set();
let announcement = null;
let voiceIndex = null;
let preparedVoice = null;
const clipCache = new Map();
const clipQueue = [];
let clipFetches = 0;
const wakeSupported = Boolean(navigator.wakeLock &&
  typeof navigator.wakeLock.request === 'function');
let wakeSentinel = null;
let wakePending = null;
let wakeVersion = 0;

function asError(value, context) {
  const error = value instanceof Error ? value : new Error(String(value));
  return context ? new Error(context + ': ' + error.message, {cause: error}) : error;
}

function renderMessages() {
  for (const [id, messages] of [
    ['errors', [...errors.values()]],
    ['warnings', [...warnings.values(), ...routineWarnings]]
  ]) {
    const list = elements[id];
    list.replaceChildren();
    for (const message of [...new Set(messages)]) {
      const item = document.createElement('li');
      item.textContent = message;
      list.append(item);
    }
    list.hidden = !messages.length;
  }
}

function reportError(value, context) {
  const error = asError(value, context);
  console.error(error);
  errors.set(error.message, error.message);
  renderMessages();
}

function reportWarning(value, context) {
  const error = asError(value, context);
  console.warn(error);
  warnings.set(error.message, error.message);
  renderMessages();
}

function routineWarning(message) {
  const error = asError(message);
  routineWarnings.push(error.message);
  const key = selectedSession + ':' + error.message;
  if (!loggedRoutineWarnings.has(key)) {
    console.warn(error);
    loggedRoutineWarnings.add(key);
  }
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

function fetchedTime(date) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

function copyDate(date) {
  return new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short'}).format(date);
}

function parseRoutine(csv) {
  if (typeof csv !== 'string') throw new Error('The routine CSV must be text');
  const found = findSessions(parseCsv(csv));
  if (!Array.isArray(found) || !found.length) throw new Error('The CSV contains no sessions');
  return found;
}

function validateSchedule(built) {
  if (!built.segments.length || !Number.isFinite(built.total) || built.total <= 0) {
    throw new Error('This session has no timed segments');
  }
  let total = 0;
  for (const segment of built.segments) {
    if (!Number.isFinite(segment.seconds) || segment.seconds <= 0) {
      throw new Error('Invalid duration for ' + segment.label);
    }
    total += segment.seconds;
  }
  if (Math.abs(total - built.total) > 0.000001) {
    throw new Error('The session total does not match its segments');
  }
}

function configuredSource() {
  const params = new URLSearchParams(location.search);
  const override = params.has('data');
  const value = override ? params.get('data') : DATA_URL;
  if (!value.trim()) {
    if (override) throw new Error('The data override must name a CSV source');
    throw new Error('No data source is configured');
  }
  const url = new URL(value, location.href);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The routine source must use http or https');
  }
  if (override && url.origin !== location.origin) {
    throw new Error('The data override must have the same origin as this page');
  }
  return url.href;
}

function readCachedCopy() {
  try {
    const stored = localStorage.getItem(CSV_KEY);
    if (stored === null) return null;
    const copy = JSON.parse(stored);
    if (!copy || typeof copy.csv !== 'string' ||
        !['string', 'number'].includes(typeof copy.fetchedAt) || copy.fetchedAt === '') {
      throw new Error('The stored copy must contain fetchedAt and CSV text');
    }
    const date = new Date(copy.fetchedAt);
    if (!Number.isFinite(date.getTime())) throw new Error('The stored copy has an invalid date');
    for (const session of parseRoutine(copy.csv)) {
      validateSchedule(buildSchedule(session, {includeOptional: true}));
    }
    return {csv: copy.csv, date};
  } catch (error) {
    reportWarning(error, 'The saved routine could not be read');
    return null;
  }
}

async function loadRoutine() {
  let source;
  try {
    source = configuredSource();
  } catch (error) {
    elements['source-status'].textContent = '';
    reportError(error);
    return;
  }
  cachedCopy = readCachedCopy();
  try {
    const response = await fetch(source, {cache: 'no-store'});
    if (!response.ok) throw new Error('Routine request failed: HTTP ' + response.status);
    const csv = await response.text();
    const found = parseRoutine(csv);
    const date = new Date();
    installRoutine(found);
    elements['source-status'].textContent = 'Routine from the sheet, fetched ' + fetchedTime(date);
    elements.offline.hidden = true;
    try {
      localStorage.setItem(CSV_KEY, JSON.stringify({fetchedAt: date.toISOString(), csv}));
    } catch (error) {
      reportWarning(error, 'The routine could not be saved for offline use');
    }
  } catch (error) {
    schedule = null;
    elements.start.disabled = true;
    elements['source-status'].textContent = '';
    reportError(error, 'The routine could not be loaded');
    if (cachedCopy) {
      elements.offline.textContent = 'Use the copy from ' + copyDate(cachedCopy.date);
      elements.offline.hidden = false;
    }
  }
}

function installRoutine(found) {
  sessions = found;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
  const match = new RegExp('\\b' + weekday + '\\b', 'i');
  const today = sessions.findIndex(session => match.test(session.name));
  selectedSession = today < 0 ? 0 : today;
  elements.sessions.replaceChildren();
  sessions.forEach((session, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = session.name;
    button.addEventListener('click', () => chooseSession(index));
    elements.sessions.append(button);
  });
  chooseSession(selectedSession, true);
}

function chooseSession(index, propagate = false) {
  preparedVoice = null;
  warnings.delete('voice-missing');
  selectedSession = index;
  optionalChoices = new Set();
  elements.sessions.querySelectorAll('button').forEach((button, buttonIndex) => {
    button.setAttribute('aria-pressed', String(buttonIndex === index));
  });
  elements['optional-groups'].replaceChildren();
  const session = sessions[index];
  elements.optional.hidden = !session.optional.length;
  try {
    session.optional.forEach((block, blockIndex) => {
      const duration = buildSchedule({name: session.name, rows: block.rows, optional: []},
        {includeOptional: false}).total;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Optional block has no valid duration: ' + block.label);
      }
      const label = document.createElement('label');
      label.className = 'timer-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const text = document.createElement('span');
      text.textContent = block.label + ', ' + formatTime(duration);
      label.append(checkbox, text);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) optionalChoices.add(blockIndex);
        else optionalChoices.delete(blockIndex);
        updateSchedule();
      });
      elements['optional-groups'].append(label);
    });
    updateSchedule(propagate);
  } catch (error) {
    schedule = null;
    elements.start.disabled = true;
    if (propagate) throw error;
    reportError(error, 'The session could not be prepared');
  }
}

function safeLink(value) {
  if (!value || !value.trim()) return null;
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Demo link must use http or https: ' + value);
    }
    return url.href;
  } catch (error) {
    routineWarning(asError(error, 'Unsafe or invalid demo link'));
    return null;
  }
}

function updateSchedule(propagate = false) {
  schedule = null;
  preparedVoice = null;
  warnings.delete('voice-missing');
  elements.start.disabled = true;
  elements.routine.replaceChildren();
  elements['session-total'].textContent = '';
  routineWarnings = [];
  const session = sessions[selectedSession];
  const chosen = {...session,
    optional: session.optional.filter((block, index) => optionalChoices.has(index))};
  try {
    const built = buildSchedule(chosen, {includeOptional: true});
    validateSchedule(built);
    rowOffsets = rowStarts(built.segments);
    let total = 0;
    offsets = [];
    rowEnds = new Map();
    for (const segment of built.segments) {
      offsets.push(total);
      total += segment.seconds;
      rowEnds.set(segment.rowIndex, total);
    }
    for (const warning of built.warnings) routineWarning(warning);
    segmentLinks = built.segments.map(segment => safeLink(segment.link));
    const rows = [...chosen.rows, ...chosen.optional.flatMap(block => block.rows)];
    gates = changePoints(built.segments).map(point => {
      const index = offsets.indexOf(rowOffsets[point.rowIndex]);
      const segment = built.segments[index];
      const row = rows[point.rowIndex];
      if (!row || !segment || segment.rowIndex !== point.rowIndex ||
          !Number.isFinite(point.at) || point.at < 0 || point.at > rowOffsets[point.rowIndex]) {
        throw new Error('Invalid row change point for row ' + (point.rowIndex + 1));
      }
      return {...point, start: rowOffsets[point.rowIndex], exercise: row.exercise,
        notes: segment.notes, link: segmentLinks[index], cue: nextCue(row.exercise)};
    });
    for (const [rowIndex, row] of rows.entries()) {
      const fromSeconds = rowOffsets[rowIndex];
      const item = document.createElement('li');
      for (const [className, value] of [
        ['timer-row-clock', row.clock], ['timer-row-exercise', row.exercise],
        ['timer-row-dose', row.dose]
      ]) {
        const text = document.createElement(className === 'timer-row-exercise' ? 'button' : 'span');
        text.className = className;
        text.textContent = value;
        if (className === 'timer-row-exercise') {
          text.type = 'button';
          text.addEventListener('click', () => start(fromSeconds));
        }
        item.append(text);
      }
      elements.routine.append(item);
    }
    schedule = built;
    prepareVoice(built);
    elements['session-total'].textContent = 'Session total ' + formatTime(built.total);
    elements.start.disabled = false;
  } catch (error) {
    if (propagate) throw error;
    reportError(error, 'The session could not be prepared');
  }
  renderMessages();
}

function readVoice() {
  try {
    const stored = localStorage.getItem(VOICE_KEY);
    if (stored === 'on' || stored === 'off') voiceOn = stored === 'on';
    else if (stored !== null) throw new Error('Invalid stored voice setting: ' + stored);
  } catch (error) {
    reportWarning(error, 'The voice setting could not be read; voice starts on');
  }
  renderVoice();
}

function renderVoice() {
  elements.voice.textContent = 'Voice ' + (voiceOn ? 'on' : 'off');
  elements.voice.setAttribute('aria-pressed', String(voiceOn));
}

function readChanges() {
  try {
    const stored = localStorage.getItem(CHANGES_KEY);
    if (stored === 'wait' || stored === 'timed') changesMode = stored;
    else if (stored !== null) throw new Error('Invalid stored changes setting: ' + stored);
  } catch (error) {
    reportWarning(error, 'The changes setting could not be read; changes start in wait mode');
  }
  renderChanges();
}

function renderChanges() {
  elements.changes.textContent = 'Changes: ' + changesMode;
  elements.changes.setAttribute('aria-pressed', String(changesMode === 'wait'));
}

function nextCue(exercise) {
  return 'Next, ' + exercise[0].toLowerCase() + exercise.slice(1);
}

async function loadVoiceIndex() {
  const url = new URL('voice/index.json', location.href);
  const response = await fetch(url.href, {cache: 'no-cache'});
  if (!response.ok) throw new Error('Voice index request failed: HTTP ' + response.status);
  const index = await response.json();
  if (!index || typeof index !== 'object' || Array.isArray(index) ||
      typeof index.engine !== 'string' || !index.engine.trim() ||
      typeof index.voice !== 'string' || !index.voice.trim() ||
      !index.clips || typeof index.clips !== 'object' || Array.isArray(index.clips)) {
    throw new Error('The voice index must contain engine, voice, and a clips object');
  }
  const clips = new Map();
  const directory = new URL('./', url);
  for (const [cue, file] of Object.entries(index.clips)) {
    if (!cue.trim() || typeof file !== 'string' || !file.trim() ||
        /^(?:[a-z][a-z\d+.-]*:|[\/\\])/i.test(file)) {
      throw new Error('Invalid voice clip entry: ' + cue);
    }
    const clipUrl = new URL(file, directory);
    if (clipUrl.origin !== directory.origin || !clipUrl.pathname.startsWith(directory.pathname) ||
        !/\.mp3$/i.test(clipUrl.pathname) || clipUrl.search || clipUrl.hash) {
      throw new Error('Voice clip must be a relative MP3 file within voice/: ' + cue);
    }
    clips.set(cue, clipUrl.href);
  }
  voiceIndex = clips;
  if (preparedVoice) loadPreparedVoice(preparedVoice);
}

function prepareVoice(built) {
  const cues = [...new Set([...built.segments.map(segment => segment.speech),
    ...gates.map(gate => gate.cue), 'Done'])].sort();
  preparedVoice = {schedule: built, cues, entries: new Map()};
  if (voiceIndex) loadPreparedVoice(preparedVoice);
}

function loadPreparedVoice(prepared) {
  if (prepared !== preparedVoice) return;
  const missing = [];
  for (const cue of prepared.cues) {
    const url = voiceIndex.get(cue);
    if (url) prepared.entries.set(cue, queueClip(url));
    else missing.push(cue);
  }
  warnings.delete('voice-missing');
  if (missing.length) {
    const message = 'No voice clip for: ' + missing.join(', ') + '; beeps only there';
    console.warn(new Error(message));
    warnings.set('voice-missing', message);
  }
  renderMessages();
  playAnnouncement();
}

function queueClip(url) {
  if (clipCache.has(url)) return clipCache.get(url);
  const entry = {url, bytes: null, buffer: null, decoding: null};
  entry.loaded = new Promise((resolve, reject) => {
    clipQueue.push({entry, resolve, reject});
  });
  clipCache.set(url, entry);
  entry.loaded.then(bytes => {
    entry.bytes = bytes;
    decodeClip(entry);
  }, error => reportError(error, 'Voice clip could not be loaded: ' + url));
  fetchClips();
  return entry;
}

function fetchClips() {
  while (clipFetches < 4 && clipQueue.length) {
    const job = clipQueue.shift();
    clipFetches++;
    fetchClip(job.entry.url).then(job.resolve, job.reject).finally(() => {
      clipFetches--;
      fetchClips();
    });
  }
}

async function fetchClip(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Voice clip request failed: HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) throw new Error('The voice clip is empty');
  return bytes;
}

function decodeClip(entry) {
  if (!audioContext || !entry.bytes || entry.decoding) return;
  entry.decoding = Promise.resolve().then(() => audioContext.decodeAudioData(entry.bytes.slice(0)));
  entry.decoding.then(buffer => {
    entry.buffer = buffer;
    playAnnouncement();
  }, error => reportError(error, 'Voice clip could not be decoded: ' + entry.url));
}

function audioStateChanged() {
  if (audioContext.state === 'running') {
    if (warnings.delete(AUDIO_PAUSED)) renderMessages();
    playAnnouncement();
  }
}

function resumeAudio(create = false) {
  if (!audioContext && create) {
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    } catch (error) {
      reportWarning(error, 'Ambient audio mode could not be set');
    }
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio is unsupported here');
      audioContext = new Context();
      audioContext.addEventListener('statechange', audioStateChanged);
    } catch (error) {
      reportError(error, 'Sound could not be initialized');
    }
  }
  if (!audioContext) return;
  try {
    // Resume must be invoked before leaving the original gesture, including Start.
    const pending = audioContext.resume();
    Promise.resolve(pending).then(audioStateChanged,
      error => reportError(error, 'Sound could not be resumed'));
  } catch (error) {
    reportError(error, 'Sound could not be resumed');
  }
  for (const entry of clipCache.values()) decodeClip(entry);
}

function soundRunning() {
  if (audioContext && audioContext.state === 'running') return true;
  if (!warnings.has(AUDIO_PAUSED)) reportWarning(new Error(AUDIO_PAUSED));
  return false;
}

function stopTones() {
  for (const tone of toneNodes) {
    try {
      tone.oscillator.stop();
      tone.oscillator.disconnect();
      tone.gain.disconnect();
    } catch (error) {
      reportError(error, 'A tone could not be stopped');
    }
  }
  toneNodes.clear();
}

function playTone(name) {
  if (!soundRunning()) return null;
  try {
    const start = audioContext.currentTime;
    const end = start + (name === 'short' ? 0.08 : 0.25);
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(name === 'short' ? 880 : 1320, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.25, start + 0.005);
    gain.gain.setValueAtTime(0.25, end - 0.01);
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    const tone = {oscillator, gain};
    toneNodes.add(tone);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      toneNodes.delete(tone);
    };
    oscillator.start(start);
    oscillator.stop(end);
    return end;
  } catch (error) {
    reportError(error, 'The ' + name + ' tone could not play');
    return null;
  }
}

function cancelVoice() {
  const previous = announcement;
  announcement = null;
  if (!previous || !previous.source) return;
  try {
    previous.source.stop();
    previous.source.disconnect();
  } catch (error) {
    reportError(error, 'The voice clip could not be stopped');
  }
}

function announce(cue) {
  cancelVoice();
  stopTones();
  announcement = {cue, after: null, played: false, tonePending: true,
    prepared: preparedVoice, source: null, run: runId, phase,
    segment: currentSegment, gate: waitingGate};
  if (!soundRunning()) return;
  playAnnouncement();
}

function playAnnouncement() {
  const current = announcement;
  if (!current) return;
  if (current.prepared !== preparedVoice || current.run !== runId || current.phase !== phase ||
      (phase === 'waiting' && current.gate !== waitingGate)) {
    cancelVoice();
    return;
  }
  if (phase === 'running') {
    const elapsed = elapsedAt();
    if (elapsed >= schedule.total || segmentAt(elapsed) !== current.segment ||
        (changesMode === 'wait' && gates.some(gate =>
          !crossedChanges.has(gate.rowIndex) && gate.at <= elapsed))) {
      cancelVoice();
      return;
    }
  }
  if (!audioContext || audioContext.state !== 'running') return;
  if (current.tonePending) {
    const after = playTone('long');
    if (after === null) return;
    current.after = after;
    current.tonePending = false;
  }
  if (current.played || !voiceOn) return;
  const entry = preparedVoice && preparedVoice.entries.get(current.cue);
  if (!entry || !entry.buffer) return;
  try {
    const source = audioContext.createBufferSource();
    source.buffer = entry.buffer;
    source.connect(audioContext.destination);
    current.source = source;
    source.onended = () => {
      source.disconnect();
      if (current.source === source) current.source = null;
    };
    source.start(Math.max(audioContext.currentTime, current.after));
    current.played = true;
  } catch (error) {
    current.played = true;
    reportError(error, 'The voice clip could not play: ' + current.cue);
  }
}

function active() {
  return phase === 'running' || phase === 'paused' || phase === 'waiting';
}

function wakeRefused(value) {
  const error = asError(value);
  const name = error.name || 'Error';
  elements.wake.textContent = 'Screen may lock: ' + name + ' — set Auto-Lock to Never for this session';
  reportWarning(error, 'Screen wake lock was refused');
}

function releaseSentinel(sentinel, version, status) {
  const failed = error => {
    reportWarning(error, 'Screen wake lock could not be released');
    if (version === wakeVersion) {
      elements.wake.textContent = 'Screen wake lock release failed: ' + asError(error).name;
    }
  };
  try {
    const released = sentinel.release();
    Promise.resolve(released).then(() => {
      if (version === wakeVersion && status) elements.wake.textContent = status;
    }, failed);
  } catch (error) {
    failed(error);
  }
}

function requestWakeLock(id) {
  if (!active() || id !== runId) return;
  if (!wakeSupported) {
    elements.wake.textContent = 'Wake lock unsupported here';
    return;
  }
  if (wakeSentinel && !wakeSentinel.released) return;
  if (wakePending && wakePending.run === id) return;
  const version = ++wakeVersion;
  const request = {run: id, version};
  wakePending = request;
  elements.wake.textContent = 'Requesting screen wake lock…';
  const refused = error => {
    if (wakePending === request) wakePending = null;
    if (version === wakeVersion && id === runId && active()) wakeRefused(error);
    else reportWarning(error, 'An earlier screen wake lock request was refused');
  };
  try {
    // Keep this invocation in Start's synchronous gesture path.
    const pending = navigator.wakeLock.request('screen');
    Promise.resolve(pending).then(sentinel => {
      if (wakePending === request) wakePending = null;
      if (version !== wakeVersion || id !== runId || !active()) {
        releaseSentinel(sentinel, version, null);
        return;
      }
      wakeSentinel = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeSentinel !== sentinel || version !== wakeVersion) return;
        wakeSentinel = null;
        elements.wake.textContent = active() ? 'Screen wake lock released; screen may lock' :
          'Screen wake lock released';
      });
      elements.wake.textContent = sentinel.released ?
        'Screen wake lock released; screen may lock' : 'Screen stays awake';
      if (sentinel.released) wakeSentinel = null;
    }, refused);
  } catch (error) {
    refused(error);
  }
}

function releaseWakeLock() {
  const version = ++wakeVersion;
  wakePending = null;
  const sentinel = wakeSentinel;
  wakeSentinel = null;
  if (sentinel) {
    elements.wake.textContent = 'Releasing screen wake lock…';
    releaseSentinel(sentinel, version, 'Screen wake lock released');
  } else {
    elements.wake.textContent = wakeSupported ? 'Screen wake lock released' : 'Wake lock unsupported here';
  }
}

function elapsedAt(now = Date.now()) {
  if (phase === 'paused' || phase === 'waiting') return heldElapsed;
  return Math.max(0, (now - startedAt) / 1000);
}

function segmentAt(elapsed) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= elapsed) low = middle;
    else high = middle - 1;
  }
  return low;
}

function showSegment(index) {
  const segment = schedule.segments[index];
  elements.segment.textContent = segment.label;
  elements.next.textContent = 'Next: ' +
    (index + 1 < schedule.segments.length ? schedule.segments[index + 1].label : 'Done');
  showDetails(segment.notes, segmentLinks[index]);
}

function showDetails(notes, link) {
  elements.notes.replaceChildren();
  for (const line of notes) {
    const item = document.createElement('li');
    item.textContent = line;
    elements.notes.append(item);
  }
  elements.notes.hidden = !notes.length;
  elements['demo-line'].hidden = !link;
  if (link) elements.demo.href = link;
  else elements.demo.removeAttribute('href');
}

function renderControls() {
  elements.ready.hidden = phase !== 'waiting';
  elements.pause.hidden = phase === 'waiting';
  elements.pause.textContent = phase === 'paused' ? 'Resume' : 'Pause';
}

function waitForReady(gate) {
  heldElapsed = gate.at;
  waitingGate = gate;
  phase = 'waiting';
  currentSegment = -1;
  previousRemaining = null;
  soundedTicks.clear();
  elements.countdown.textContent = 'Ready';
  elements.countdown.setAttribute('aria-label', 'Waiting for Ready');
  elements.segment.textContent = 'Next: ' + gate.exercise;
  elements.next.textContent = 'Press Ready to begin';
  elements.timing.textContent = 'Row ' + (gate.rowIndex + 1) + ' of ' + rowOffsets.length +
    ' · waiting for Ready';
  elements.progress.setAttribute('aria-valuemax', '1');
  elements.progress.setAttribute('aria-valuenow', '0');
  elements['progress-fill'].style.transform = 'scaleX(0)';
  showDetails(gate.notes, gate.link);
  renderControls();
  announce(gate.cue);
}

function resetChanges(elapsed, includeCurrent = false) {
  crossedChanges = new Set(gates.filter(gate => gate.at < elapsed ||
    (includeCurrent && gate.at === elapsed)).map(gate => gate.rowIndex));
}

function tick({suppressTick = false} = {}) {
  if (!active() || phase === 'waiting') return;
  const elapsed = elapsedAt();
  if (phase === 'running' && changesMode === 'wait') {
    const gate = gates.find(point => !crossedChanges.has(point.rowIndex) && point.at <= elapsed);
    if (gate) {
      waitForReady(gate);
      return;
    }
  }
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  const segment = schedule.segments[index];
  const segmentElapsed = elapsed - offsets[index];
  const remaining = Math.ceil(segment.seconds - segmentElapsed);
  const changed = index !== currentSegment;
  if (changed) {
    soundedTicks.clear();
    previousRemaining = null;
    cancelVoice();
    stopTones();
    currentSegment = index;
    showSegment(index);
    if (phase === 'running') {
      announce(segment.speech);
    }
  }
  const tickKey = index + ':' + remaining;
  if (remaining >= 1 && remaining <= 3 && !soundedTicks.has(tickKey)) {
    if (phase === 'running' && !suppressTick && (changed || remaining !== previousRemaining)) {
      playTone('short');
    }
    soundedTicks.add(tickKey);
  }
  previousRemaining = remaining;
  elements.countdown.textContent = formatTime(remaining);
  elements.countdown.setAttribute('aria-label', formatTime(remaining) + ' remaining');
  elements.timing.textContent = 'Row ' + (segment.rowIndex + 1) + ' of ' + rowOffsets.length + ' · ' +
    'Slot ' + segment.clock + ' · ' +
    formatTime(rowEnds.get(segment.rowIndex) - elapsed) + ' left in slot · ' +
    formatTime(Math.floor(elapsed)) + ' / ' + formatTime(schedule.total) + ' elapsed';
  elements.progress.setAttribute('aria-valuemax', String(segment.seconds));
  elements.progress.setAttribute('aria-valuenow', String(segmentElapsed));
  elements['progress-fill'].style.transform = 'scaleX(' + (segmentElapsed / segment.seconds) + ')';
}

function start(fromSeconds = 0) {
  if (!schedule || active()) return;
  if (typeof fromSeconds !== 'number' || !Number.isFinite(fromSeconds) ||
      fromSeconds < 0 || fromSeconds >= schedule.total) {
    reportError(new Error('The start offset must be a finite nonnegative number below the session total'));
    return;
  }
  runId++;
  phase = 'running';
  startedAt = Date.now() - fromSeconds * 1000;
  heldElapsed = fromSeconds;
  waitingGate = null;
  resetChanges(fromSeconds, true);
  currentSegment = -1;
  previousRemaining = null;
  soundedTicks = new Set();
  elements.preparation.hidden = true;
  elements.finished.hidden = true;
  elements.running.hidden = false;
  renderControls();
  requestWakeLock(runId);
  resumeAudio(true);
  tick();
  interval = setInterval(tick, 200);
  elements.running.focus();
}

function togglePause() {
  if (phase === 'running') {
    tick();
    if (phase !== 'running') return;
    heldElapsed = elapsedAt();
    phase = 'paused';
    renderControls();
    cancelVoice();
    stopTones();
    tick({suppressTick: true});
  } else if (phase === 'paused') {
    resumeAudio();
    startedAt = Date.now() - heldElapsed * 1000;
    phase = 'running';
    renderControls();
    tick({suppressTick: true});
    if (document.visibilityState === 'visible') requestWakeLock(runId);
  }
}

function seek(desiredElapsed, {bypassChanges = false, run = false} = {}) {
  if (!active()) return;
  if (run || phase === 'waiting') phase = 'running';
  heldElapsed = desiredElapsed;
  startedAt = Date.now() - desiredElapsed * 1000;
  waitingGate = null;
  resetChanges(desiredElapsed, bypassChanges);
  currentSegment = -1;
  cancelVoice();
  stopTones();
  renderControls();
  tick({suppressTick: true});
}

function ready() {
  if (phase !== 'waiting') return;
  resumeAudio();
  seek(waitingGate.start, {bypassChanges: true, run: true});
  requestWakeLock(runId);
}

function back() {
  if (!active()) return;
  tick();
  if (!active()) return;
  if (phase === 'waiting') {
    const target = Math.max(0, segmentAt(waitingGate.at) - 1);
    seek(offsets[target], {bypassChanges: true, run: true});
    return;
  }
  const elapsed = elapsedAt();
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  const target = elapsed - offsets[index] > 3 ? index : Math.max(0, index - 1);
  seek(offsets[target], {bypassChanges: schedule.segments[target].kind !== 'next'});
}

function skip() {
  if (!active()) return;
  resumeAudio();
  tick();
  if (!active()) return;
  if (phase === 'waiting') {
    ready();
    return;
  }
  const elapsed = elapsedAt();
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  seek(index + 1 < offsets.length ? offsets[index + 1] : schedule.total);
}

function nextRow() {
  if (!active()) return;
  resumeAudio();
  tick();
  if (!active()) return;
  if (phase === 'waiting') {
    ready();
    return;
  }
  const elapsed = elapsedAt();
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  const nextRowIndex = schedule.segments[index].rowIndex + 1;
  seek(nextRowIndex < rowOffsets.length ? rowOffsets[nextRowIndex] : schedule.total,
    {bypassChanges: true});
}

function clearRun() {
  clearInterval(interval);
  interval = null;
  cancelVoice();
  stopTones();
  releaseWakeLock();
}

function finish() {
  if (!active()) return;
  phase = 'done';
  clearRun();
  elements.running.hidden = true;
  elements.finished.hidden = false;
  elements['done-total'].textContent = 'Session total ' + formatTime(schedule.total);
  announce('Done');
  elements['done-heading'].focus();
}

function stop() {
  phase = 'preparation';
  clearRun();
  elements.running.hidden = true;
  elements.finished.hidden = true;
  elements.preparation.hidden = false;
  elements.start.focus();
}

function toggleChanges() {
  if (phase === 'running') tick();
  changesMode = changesMode === 'wait' ? 'timed' : 'wait';
  if (phase === 'waiting') {
    resumeAudio();
    seek(heldElapsed, {bypassChanges: true, run: true});
    requestWakeLock(runId);
  } else if (active()) {
    resetChanges(elapsedAt(), true);
  }
  renderChanges();
  try {
    localStorage.setItem(CHANGES_KEY, changesMode);
  } catch (error) {
    reportWarning(error, 'The changes setting could not be saved');
  }
}

elements.start.addEventListener('click', () => start());
elements.pause.addEventListener('click', togglePause);
elements.ready.addEventListener('click', ready);
elements.changes.addEventListener('click', toggleChanges);
elements.back.addEventListener('click', back);
elements.skip.addEventListener('click', skip);
elements['next-row'].addEventListener('click', nextRow);
elements.stop.addEventListener('click', stop);
elements.return.addEventListener('click', stop);
elements.voice.addEventListener('click', () => {
  voiceOn = !voiceOn;
  cancelVoice();
  renderVoice();
  try {
    localStorage.setItem(VOICE_KEY, voiceOn ? 'on' : 'off');
  } catch (error) {
    reportWarning(error, 'The voice setting could not be saved');
  }
});
elements.offline.addEventListener('click', () => {
  if (!cachedCopy) {
    reportError(new Error('No valid saved routine is available'));
    return;
  }
  try {
    installRoutine(parseRoutine(cachedCopy.csv));
    elements['source-status'].textContent = 'Offline copy from ' + copyDate(cachedCopy.date);
    elements.offline.hidden = true;
  } catch (error) {
    schedule = null;
    elements.start.disabled = true;
    reportError(error, 'The saved routine could not be loaded');
  }
});

document.addEventListener('keydown', event => {
  if (event.key !== ' ' || event.repeat || !active() || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) return;
  if (phase === 'waiting') {
    event.preventDefault();
    ready();
    return;
  }
  if (target instanceof Element && (target.isContentEditable ||
      target.closest('input, textarea, select, button, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"])'))) return;
  event.preventDefault();
  togglePause();
});
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    if (audioContext && audioContext.state !== 'running') resumeAudio();
  }, {capture: true});
}
document.addEventListener('visibilitychange', () => {
  if (!active()) return;
  tick();
  if (active() && document.visibilityState === 'visible') requestWakeLock(runId);
});
window.addEventListener('pagehide', () => {
  if (active()) releaseWakeLock();
});

readVoice();
readChanges();
if (!wakeSupported) {
  elements.wake.textContent = 'Wake lock unsupported here';
  reportWarning(new Error('Wake lock unsupported here'));
}
loadVoiceIndex().catch(error => reportError(error, 'The voice index could not be loaded'));
loadRoutine();
