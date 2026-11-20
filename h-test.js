import {rotationMatrix, validOrientation, wrap180} from './math.js';
import {angularRate, captureFlags, legPitch, measureRep, Repetitions, stableZero, summary} from './h-math.js';

const KEY = 'lihps-askling-imu-v1';
const SESSION = 'lihps-askling-imu-session-v1';
const MAX_REPS = 10;
const SELECTION_LABELS = {all: 'All repetitions', last3: 'Last three repetitions',
  fastest3: 'Three fastest repetitions', rom3: 'Three highest ROM repetitions'};
const id = () => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint32Array(4))].join('-');
const $ = name => document.getElementById('h-' + name);
const number = value => Number.isFinite(value) ? value.toFixed(1) : '—';

function readHistory() {
  const data = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  if (!Array.isArray(data)) throw new Error('Invalid history');
  return data;
}

function element(tag, content) {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}

function rateCell(average, minimum) {
  return number(average) + ' / ' + number(minimum);
}

function showSet(container, set) {
  const {reps, state} = set;
  const mode = set.selection ?? 'all';
  const stats = summary(reps, mode);
  container.replaceChildren(element('p', `${reps.length} raises recorded · ${state}`));
  const practiceNotes = captureFlags(set.practiceFlags ?? []);
  if (practiceNotes.length) container.append(element('p', `Practice QC: ${practiceNotes.join(', ')}`));
  container.append(element('p', `${SELECTION_LABELS[mode]} · Reported reps ${stats.selected.map(index => index + 1).join(', ') || 'none'}`));
  if (reps.some(rep => rep.speedSource === 'orientation')) {
    container.append(element('p', 'Some peak speeds are estimated from changes in flexion angle, shown as Angle.'));
  }
  if (reps.length) {
    const scroll = element('div', '');
    scroll.className = 'h-table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Repetition results, scroll horizontally for sampling and QC');
    const table = document.createElement('table');
    table.className = 'h-table';
    const head = table.createTHead().insertRow();
    for (const label of ['Rep', 'Report', 'ROM °', 'Peak °/s', 'Speed source',
      'Angle Hz avg / min', 'Gyro Hz avg / min', 'Max gap ms angle / gyro', 'QC']) {
      const cell = element('th', label);
      cell.scope = 'col';
      head.append(cell);
    }
    const body = table.createTBody();
    reps.forEach((rep, i) => {
      const row = body.insertRow();
      const qc = captureFlags(rep.flags);
      for (const value of [i + 1, stats.selected.includes(i) ? '✓' : '', number(rep.peak),
        number(rep.speed), rep.speedSource === 'orientation' ? 'Angle' : 'Gyro',
        rateCell(rep.orientationHz, rep.orientationMinHz), rateCell(rep.gyroHz, rep.gyroMinHz),
        rateCell(rep.gap, rep.gyroGap), qc.join(', ') || 'Accepted']) {
        row.insertCell().textContent = value;
      }
    });
    scroll.append(table);
    container.append(scroll);
    container.append(element('p',
      'Hz shows average / minimum interval rate. A gap over 50 ms or an average below 30 Hz flags the affected measurement. Flagged values are excluded from summary metrics.'));
  }
  container.append(element('p',
    `Reported ROM max / mean: ${number(stats.bestRom)}° / ${number(stats.meanRom)}° (${stats.validRom} usable). ` +
    `Peak speed max / mean: ${number(stats.bestSpeed)} / ${number(stats.meanSpeed)}°/s (${stats.valid} usable).`));
}

function downloadHistory(sets) {
  const rows = [[
    'session_id','set_id','started_utc','side','target_reps','modified_protocol','set_status',
    'practice_qc','gyro_channel','gyro_sign','pain_vas','insecurity_vas','rep','peak_rom_deg','peak_flexion_deg_s',
    'duration_ms','orientation_gap_ms','orientation_off_axis_deg','gyro_hz','gyro_gap_ms','rep_qc',
    'accepted_reps','best_rom_deg','mean_rom_deg','best_velocity_deg_s','mean_peak_velocity_deg_s',
    'peak_velocity_source','peak_off_axis_gyro_deg_s','practice_off_axis_deg','practice_peak_off_axis_gyro_deg_s','practice_gyro_status',
    'orientation_hz','orientation_min_interval_hz','orientation_samples','gyro_min_interval_hz','gyro_samples',
    'report_mode','included_in_report','reported_rep_numbers','usable_rom_reps','practice_included','app_version'
  ]];
  for (const set of sets) {
    const stats = summary(set.reps, set.selection);
    const practiceIncluded = set.practiceIncluded ?? true;
    (set.reps.length ? set.reps : [null]).forEach((rep, index) => {
      const axis = rep && 'axis' in rep ? rep.axis : set.axis;
      rows.push([
        set.session, set.id, set.started, set.side, set.target,
        !practiceIncluded || set.target !== 3, set.state,
        (set.practiceFlags ?? []).join('; '), axis?.channel, axis?.sign,
        set.pain, set.insecurity, rep ? index + 1 : null,
        rep?.peak, rep?.speed, rep?.duration, rep?.gap, rep?.offAxis, rep?.gyroHz, rep?.gyroGap,
        rep?.flags.join('; '), stats.valid, stats.bestRom, stats.meanRom, stats.bestSpeed, stats.meanSpeed,
        rep?.speedSource ?? (Number.isFinite(rep?.speed) ? 'gyroscope' : null),
        rep?.offAxisSpeed, set.practiceOffAxis, set.practiceOffAxisSpeed, set.practiceGyroStatus,
        rep?.orientationHz, rep?.orientationMinHz, rep?.samples, rep?.gyroMinHz, rep?.gyroSamples,
        set.selection ?? 'all', !!rep && stats.selected.includes(index),
        stats.selected.map(i => i + 1).join('; '), stats.validRom, practiceIncluded, set.version
      ]);
    });
  }
  const csv = rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lihps-askling-imu.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setupHTest({sensorsEnabled, prepareAudio, beep}) {
  let phase = 'idle';
  let session = id();
  try {
    session = localStorage.getItem(SESSION) || session;
    localStorage.setItem(SESSION, session);
  } catch {
    // Capture can still be reviewed when storage is unavailable.
  }
  let draft;
  let timer;
  let readyAfter;
  let deadline;
  let zero;
  let detector;
  let poses = [];
  let rates = [];

  const status = message => { $('status').textContent = message; };
  const active = () => phase === 'zeroing' || phase === 'recording';
  function controls() {
    $('start').hidden = phase !== 'idle';
    $('stop').hidden = !active();
    $('review').hidden = phase !== 'review';
    $('save').disabled = !draft?.reps.length;
    for (const field of ['side', 'new', 'test-cue']) $(field).disabled = phase !== 'idle';
    $('selection').disabled = active();
  }

  function history() {
    $('history').replaceChildren();
    try {
      const sets = readHistory();
      $('export').disabled = !sets.length;
      if (!sets.length) $('history').append(element('p', 'No saved sets.'));
      for (const set of [...sets].reverse()) {
        const details = document.createElement('details');
        const when = new Date(set.started).toLocaleString();
        details.append(element('summary', `${set.side} · ${when} · ${set.reps.length} raises`));
        const body = document.createElement('div');
        showSet(body, set);
        details.append(body, element('p',
          `Pain ${set.pain}/100 · Insecurity ${set.insecurity}/100 · Session ${set.session.slice(0, 8)}`));
        const remove = element('button', 'Delete set');
        remove.type = 'button';
        remove.className = 'text-button bad-text';
        remove.setAttribute('aria-label', `Delete ${set.side.toLowerCase()} set from ${when}`);
        remove.addEventListener('click', () => {
          if (!window.confirm(`Delete the ${set.side.toLowerCase()} H-Test set from ${when}?`)) return;
          try {
            localStorage.setItem(KEY, JSON.stringify(readHistory().filter(saved => saved.id !== set.id)));
          } catch {
            $('history-status').textContent = 'Could not delete the saved set.';
            return;
          }
          history();
          $('history-status').textContent = 'Set deleted.';
          $('history-title').focus();
        });
        details.append(remove);
        $('history').append(details);
      }
    } catch {
      $('export').disabled = true;
      $('history').append(element('p', 'Saved H-Test data could not be read.'));
    }
  }

  function finish(reason) {
    if (!active()) return;
    clearInterval(timer);
    draft.state = reason;
    if (detector?.active) draft.state += ' · unfinished raise excluded';
    phase = 'review';
    controls();
    showSet($('result'), draft);
    status(draft.reps.length ? 'Capture finished. Review results and enter both athlete ratings.' : reason);
    beep();
  }

  function onPose(event) {
    if (!active() || !validOrientation(event.alpha, event.beta, event.gamma)) return;
    const time = performance.now();
    const pose = {time, ...legPitch(rotationMatrix(event.alpha, event.beta, event.gamma))};
    if (phase === 'zeroing') {
      poses.push(pose);
      poses = poses.filter(sample => sample.time >= time - 650);
      const rest = stableZero(poses, rates.filter(rate => rate.time >= time - 650), time);
      if (time < readyAfter || rest === null) return;
      zero = rest;
      detector = new Repetitions();
      detector.push({time, angle: 0, offAxis: pose.offAxis});
      rates = [];
      phase = 'recording';
      deadline = time + 180000;
      status('Go · 0/10 raises. Finish the set after any completed raise.');
      beep();
      return;
    }
    if (time - detector.last.time > 500) {
      finish('Interrupted · orientation stream gap');
      return;
    }
    const angle = wrap180(pose.pitch - zero);
    if (angle < -15 && !detector.active) {
      finish('Unexpected rotation direction · check phone alignment');
      return;
    }
    const rep = detector.push({time, angle, offAxis: pose.offAxis});
    if (!rep) return;
    const measured = measureRep(rep, rates, draft.axis);
    if (measured.axis) draft.axis = measured.axis;
    draft.reps.push(measured);
    if (draft.reps.length === MAX_REPS) {
      finish('Complete · 10 raises');
    } else {
      status(`${draft.reps.length}/10 raises recorded. Continue or select Finish set.`);
    }
  }

  $('test-cue').addEventListener('click', async () => {
    await prepareAudio();
    beep();
  });
  $('start').addEventListener('click', () => {
    if (!sensorsEnabled()) {
      status('Use Enable above and grant motion access first.');
      return;
    }
    prepareAudio();
    $('review').reset();
    draft = {session, id: id(), started: new Date().toISOString(), version: '0.4.0',
      side: $('side').value, target: MAX_REPS, selection: $('selection').value,
      practiceIncluded: false, reps: []};
    detector = null;
    zero = undefined;
    phase = 'zeroing';
    readyAfter = performance.now() + 3000;
    deadline = performance.now() + 12000;
    poses = [];
    rates = [];
    status('Keep the leg still at the start. Wait for the cue, then begin your raises.');
    controls();
    timer = setInterval(() => {
      const now = performance.now();
      if (phase === 'recording' && now - detector.last.time > 500) {
        finish('Interrupted · orientation stream gap');
      } else if (now > deadline) {
        finish(phase === 'zeroing'
          ? 'Could not zero. Hold the leg still at the starting position and check sensor access.'
          : 'Capture timed out');
      }
    }, 200);
  });
  $('stop').addEventListener('click', () => finish('Finished by operator'));
  $('selection').addEventListener('change', () => {
    if (phase !== 'review') return;
    draft.selection = $('selection').value;
    showSet($('result'), draft);
  });
  function reset(message) {
    draft = null;
    zero = undefined;
    phase = 'idle';
    controls();
    status(message);
  }
  $('discard').addEventListener('click', () => reset('Set discarded. Ready to start again.'));
  $('new').addEventListener('click', () => {
    session = id();
    try { localStorage.setItem(SESSION, session); }
    catch { status('New session started. Local storage is unavailable.'); return; }
    status('New H-Test session. Capture both legs before starting another session.');
  });
  for (const rating of ['pain', 'insecurity']) {
    const input = $(rating), slider = $(rating + '-range');
    const choose = () => { input.value = slider.value; };
    slider.addEventListener('input', choose);
    slider.addEventListener('click', choose);
    input.addEventListener('input', () => {
      if (input.validity.valid) slider.value = input.value;
    });
  }
  $('review').addEventListener('submit', event => {
    event.preventDefault();
    if (phase !== 'review' || !draft.reps.length || !$('review').reportValidity()) return;
    try {
      const sets = readHistory();
      localStorage.setItem(KEY, JSON.stringify([...sets, {
        ...draft, pain: $('pain').valueAsNumber, insecurity: $('insecurity').valueAsNumber
      }]));
    } catch {
      status('Could not save locally. This set is still in review.');
      return;
    }
    const nextSide = draft.side === 'Left' ? 'Right' : 'Left';
    $('side').value = nextSide;
    reset(`Set saved. ${nextSide} selected for the next set.`);
    history();
  });
  $('export').addEventListener('click', () => {
    try { downloadHistory(readHistory()); }
    catch { status('Saved sets could not be exported.'); }
  });
  window.addEventListener('deviceorientation', onPose, true);
  window.addEventListener('devicemotion', event => {
    if (!active()) return;
    const rate = angularRate(event);
    if (!rate) return;
    const time = performance.now();
    rates.push({...rate, time});
    while (rates[0]?.time < time - 6000) rates.shift();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finish('Interrupted · app backgrounded');
  });
  window.addEventListener('pagehide', () => finish('Interrupted · page hidden'));
  window.addEventListener('storage', event => { if (event.key === KEY) history(); });
  document.querySelectorAll('[data-screen]:not([data-screen="askling"])').forEach(button =>
    button.addEventListener('click', () => finish('Interrupted · changed screen')));
  controls();
  history();
  return sample => {
    const pitch = sample ? legPitch(sample.m).pitch : null;
    const angle = pitch === null || zero === undefined ? pitch : wrap180(pitch - zero);
    $('angle').textContent = number(angle);
    $('angle-label').textContent = zero === undefined ? 'Live leg pitch relative to horizontal' : 'Live flexion relative to starting position';
  };
}
