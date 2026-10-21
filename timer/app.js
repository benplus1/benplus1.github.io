const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTsUIH8LDFYsEKvsa0S7FKy5fkKFbA2FDA6a70tyUByPn62Y50gQwVvjdzJbpFCilxERpGecWGZeKEl/pub?gid=900002&single=true&output=csv';

import {parseCsv, findSessions, buildSchedule} from './parse.js';

const CSV_KEY = 'mobility-timer:csv';
const VOICE_KEY = 'mobility-timer:voice';
const elements = Object.fromEntries([
  'source-status', 'errors', 'warnings', 'offline', 'preparation', 'sessions',
  'optional', 'optional-groups', 'routine', 'session-total', 'start', 'running',
  'countdown', 'segment', 'progress', 'progress-fill', 'timing', 'next', 'notes',
  'demo-line', 'demo', 'pause', 'back', 'skip', 'stop', 'finished', 'done-heading',
  'done-total', 'return', 'wake', 'voice', 'tones'
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
let rowEnds = new Map();
let segmentLinks = [];
let cachedCopy = null;
let phase = 'preparation';
let startedAt = 0;
let pausedAt = 0;
let interval = null;
let currentSegment = -1;
let previousRemaining = null;
let soundedTicks = new Set();
let runId = 0;
let voiceOn = true;
let speechGesture = false;
let currentUtterance = null;
const speechSupported = typeof window.speechSynthesis !== 'undefined' &&
  typeof window.SpeechSynthesisUtterance === 'function';
const wakeSupported = Boolean(navigator.wakeLock &&
  typeof navigator.wakeLock.request === 'function');
let wakeSentinel = null;
let wakePending = null;
let wakeVersion = 0;
const tones = new Map();

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
    for (const row of rows) {
      const item = document.createElement('li');
      for (const [className, value] of [
        ['timer-row-clock', row.clock], ['timer-row-exercise', row.exercise],
        ['timer-row-dose', row.dose]
      ]) {
        const text = document.createElement('span');
        text.className = className;
        text.textContent = value;
        item.append(text);
      }
      elements.routine.append(item);
    }
    schedule = built;
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

function cancelSpeech() {
  if (!speechSupported) return;
  if (currentUtterance) currentUtterance.cancelled = true;
  currentUtterance = null;
  try {
    window.speechSynthesis.cancel();
  } catch (error) {
    reportError(error, 'Speech could not be cancelled');
  }
}

function speak(text) {
  if (!voiceOn || !speechSupported || !speechGesture) return;
  try {
    const utterance = new window.SpeechSynthesisUtterance(text);
    const entry = {utterance, cancelled: false};
    currentUtterance = entry;
    utterance.onerror = event => {
      if (entry.cancelled && (event.error === 'canceled' || event.error === 'interrupted')) return;
      reportError(new Error('Speech synthesis failed: ' + event.error));
      if (currentUtterance === entry) currentUtterance = null;
    };
    utterance.onend = () => {
      if (currentUtterance === entry) currentUtterance = null;
    };
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    currentUtterance = null;
    reportError(error, 'Speech could not start');
  }
}

function wavDataUri(milliseconds, frequency) {
  const sampleRate = 22050;
  const samples = Math.round(sampleRate * milliseconds / 1000);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) {
    const envelope = Math.min(1, index / 100, (samples - 1 - index) / 100);
    const sample = Math.sin(2 * Math.PI * frequency * index / sampleRate) * envelope;
    view.setInt16(44 + index * 2, Math.round(sample * 24575), true);
  }
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return 'data:audio/wav;base64,' + btoa(chunks.join(''));
}

function createTones() {
  for (const [name, duration, frequency] of [['short', 80, 880], ['long', 250, 1320]]) {
    try {
      const audio = document.createElement('audio');
      audio.setAttribute('playsinline', '');
      audio.preload = 'auto';
      audio.src = wavDataUri(duration, frequency);
      const tone = {audio, playback: null};
      audio.addEventListener('error', () => {
        const media = audio.error;
        reportError(new Error('The ' + name + ' tone failed: ' +
          (media ? 'media error ' + media.code + ' ' + media.message : 'unknown media error')));
      });
      tones.set(name, tone);
      elements.tones.append(audio);
    } catch (error) {
      reportError(error, 'The ' + name + ' tone could not be created');
    }
  }
}

function stopTone(tone) {
  if (tone.playback) tone.playback.cancelled = true;
  tone.playback = null;
  try {
    tone.audio.pause();
    tone.audio.currentTime = 0;
  } catch (error) {
    reportError(error, 'A tone could not be stopped');
  }
}

function stopTones() {
  for (const tone of tones.values()) stopTone(tone);
}

function unlockTones() {
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = 'playback';
    }
  } catch (error) {
    reportWarning(error, 'Audio playback mode could not be set');
  }
  for (const [name, tone] of tones) {
    let deliberatelyPaused = false;
    try {
      const pending = tone.audio.play();
      tone.audio.pause();
      deliberatelyPaused = true;
      tone.audio.currentTime = 0;
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => {
          if (deliberatelyPaused && error.name === 'AbortError') return;
          reportError(error, 'The ' + name + ' tone could not be unlocked');
        });
      }
    } catch (error) {
      reportError(error, 'The ' + name + ' tone could not be unlocked');
    }
  }
}

function playTone(name) {
  const tone = tones.get(name);
  if (!tone) return; // Creation failures are already visible and logged.
  stopTone(tone);
  const playback = {cancelled: false};
  tone.playback = playback;
  try {
    const pending = tone.audio.play();
    if (pending && typeof pending.catch === 'function') {
      pending.catch(error => {
        if (playback.cancelled && error.name === 'AbortError') return;
        reportError(error, 'The ' + name + ' tone could not play');
      });
    }
  } catch (error) {
    reportError(error, 'The ' + name + ' tone could not play');
  }
}

function active() {
  return phase === 'running' || phase === 'paused';
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
  return Math.max(0, ((phase === 'paused' ? pausedAt : now) - startedAt) / 1000);
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
  elements.notes.replaceChildren();
  for (const line of segment.notes) {
    const item = document.createElement('li');
    item.textContent = line;
    elements.notes.append(item);
  }
  elements.notes.hidden = !segment.notes.length;
  const link = segmentLinks[index];
  elements['demo-line'].hidden = !link;
  if (link) elements.demo.href = link;
  else elements.demo.removeAttribute('href');
}

function tick({suppressTick = false} = {}) {
  if (!active()) return;
  const elapsed = elapsedAt();
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
    cancelSpeech();
    stopTones();
    currentSegment = index;
    showSegment(index);
    if (phase === 'running') {
      speak(segment.speech);
      playTone('long');
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
  elements.timing.textContent = 'Slot ' + segment.clock + ' · ' +
    formatTime(rowEnds.get(segment.rowIndex) - elapsed) + ' left in slot · ' +
    formatTime(Math.floor(elapsed)) + ' / ' + formatTime(schedule.total) + ' elapsed';
  elements.progress.setAttribute('aria-valuemax', String(segment.seconds));
  elements.progress.setAttribute('aria-valuenow', String(segmentElapsed));
  elements['progress-fill'].style.transform = 'scaleX(' + (segmentElapsed / segment.seconds) + ')';
}

function start() {
  if (!schedule || active()) return;
  runId++;
  phase = 'running';
  startedAt = Date.now();
  pausedAt = 0;
  currentSegment = -1;
  previousRemaining = null;
  soundedTicks = new Set();
  speechGesture = true;
  elements.preparation.hidden = true;
  elements.finished.hidden = true;
  elements.running.hidden = false;
  elements.pause.textContent = 'Pause';
  requestWakeLock(runId);
  unlockTones();
  tick();
  interval = setInterval(tick, 200);
  elements.running.focus();
}

function togglePause() {
  if (phase === 'running') {
    tick();
    if (!active()) return;
    pausedAt = Date.now();
    phase = 'paused';
    elements.pause.textContent = 'Resume';
    cancelSpeech();
    stopTones();
    tick({suppressTick: true});
  } else if (phase === 'paused') {
    startedAt += Date.now() - pausedAt;
    pausedAt = 0;
    phase = 'running';
    elements.pause.textContent = 'Pause';
    tick({suppressTick: true});
    if (document.visibilityState === 'visible') requestWakeLock(runId);
  }
}

function seek(desiredElapsed) {
  if (!active()) return;
  const currentElapsed = elapsedAt();
  startedAt -= (desiredElapsed - currentElapsed) * 1000;
  currentSegment = -1;
  cancelSpeech();
  stopTones();
  tick({suppressTick: true});
}

function back() {
  if (!active()) return;
  const elapsed = elapsedAt();
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  const target = elapsed - offsets[index] > 3 ? index : Math.max(0, index - 1);
  seek(offsets[target]);
}

function skip() {
  if (!active()) return;
  const elapsed = elapsedAt();
  if (elapsed >= schedule.total) {
    finish();
    return;
  }
  const index = segmentAt(elapsed);
  seek(index + 1 < offsets.length ? offsets[index + 1] : schedule.total);
}

function clearRun() {
  clearInterval(interval);
  interval = null;
  cancelSpeech();
  stopTones();
  releaseWakeLock();
}

function finish() {
  if (!active()) return;
  phase = 'done';
  clearRun();
  playTone('long');
  elements.running.hidden = true;
  elements.finished.hidden = false;
  elements['done-total'].textContent = 'Session total ' + formatTime(schedule.total);
  speak('Done');
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

elements.start.addEventListener('click', start);
elements.pause.addEventListener('click', togglePause);
elements.back.addEventListener('click', back);
elements.skip.addEventListener('click', skip);
elements.stop.addEventListener('click', stop);
elements.return.addEventListener('click', stop);
elements.voice.addEventListener('click', () => {
  voiceOn = !voiceOn;
  if (!voiceOn) cancelSpeech();
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
      target.closest('input, textarea, select, button, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"])'))) return;
  event.preventDefault();
  togglePause();
});
document.addEventListener('visibilitychange', () => {
  if (!active()) return;
  tick();
  if (active() && document.visibilityState === 'visible') requestWakeLock(runId);
});
window.addEventListener('pagehide', () => {
  if (active()) releaseWakeLock();
});

readVoice();
if (!speechSupported) {
  reportWarning(new Error('Speech synthesis unsupported here; the timer and tones still work'));
}
if (!wakeSupported) {
  elements.wake.textContent = 'Wake lock unsupported here';
  reportWarning(new Error('Wake lock unsupported here'));
}
createTones();
loadRoutine();
