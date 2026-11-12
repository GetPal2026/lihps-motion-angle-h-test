import {rotationMatrix, validOrientation, wrap180} from './math.js';
import {addOrientationVelocity, addVelocity, angularRate, captureFlags, legPitch, projectRate, Repetitions, resolveAxis, stableZero, summary} from './h-math.js';

const KEY = 'lihps-askling-imu-v1';
const SESSION = 'lihps-askling-imu-session-v1';
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

function showSet(container, set) {
  const {reps, target, state, practiceFlags} = set;
  const stats = summary(reps);
  container.replaceChildren(element('p',
    `${reps.length}/${target} raises · ${stats.valid} QC accepted · ${state}`));
  const practiceNotes = captureFlags(practiceFlags);
  if (practiceNotes.length) container.append(element('p', `Practice QC: ${practiceNotes.join(', ')}`));
  if (reps.some(rep => rep.speedSource === 'orientation')) {
    container.append(element('p', 'Peak speed estimated from changes in flexion angle.'));
  }
  if (reps.length) {
    const table = document.createElement('table');
    table.className = 'h-table';
    const head = table.createTHead().insertRow();
    for (const label of ['Rep', 'ROM °', 'Peak °/s', 'QC']) head.append(element('th', label));
    const body = table.createTBody();
    reps.forEach((rep, i) => {
      const row = body.insertRow();
      for (const value of [i + 1, number(rep.peak), number(rep.speed), captureFlags(rep.flags).join(', ') || 'Accepted']) {
        row.insertCell().textContent = value;
      }
    });
    container.append(table);
  }
  container.append(element('p',
    `Accepted ROM max / mean: ${number(stats.bestRom)}° / ${number(stats.meanRom)}°. ` +
    `Peak speed max / mean: ${number(stats.bestSpeed)} / ${number(stats.meanSpeed)}°/s.`));
}

function downloadHistory(sets) {
  const rows = [[
    'session_id','set_id','started_utc','side','target_reps','modified_protocol','set_status',
    'practice_qc','gyro_channel','gyro_sign','pain_vas','insecurity_vas','rep','peak_rom_deg','peak_flexion_deg_s',
    'duration_ms','orientation_gap_ms','orientation_off_axis_deg','gyro_hz','gyro_gap_ms','rep_qc',
    'accepted_reps','best_rom_deg','mean_rom_deg','best_velocity_deg_s','mean_peak_velocity_deg_s',
    'peak_velocity_source','peak_off_axis_gyro_deg_s','practice_off_axis_deg','practice_peak_off_axis_gyro_deg_s','practice_gyro_status'
  ]];
  for (const set of sets) {
    const stats = summary(set.reps);
    (set.reps.length ? set.reps : [null]).forEach((rep, index) => rows.push([
      set.session, set.id, set.started, set.side, set.target, set.target !== 3, set.state,
      set.practiceFlags.join('; '), set.axis?.channel, set.axis?.sign, set.pain, set.insecurity, rep ? index + 1 : null,
      rep?.peak, rep?.speed, rep?.duration, rep?.gap, rep?.offAxis, rep?.gyroHz, rep?.gyroGap,
      rep?.flags.join('; '), stats.valid, stats.bestRom, stats.meanRom, stats.bestSpeed, stats.meanSpeed,
      rep?.speedSource ?? (Number.isFinite(rep?.speed) ? 'gyroscope' : null),
      rep?.offAxisSpeed, set.practiceOffAxis, set.practiceOffAxisSpeed, set.practiceGyroStatus
    ]));
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
  const active = () => ['arm-practice', 'practice', 'arm-scored', 'scored'].includes(phase);
  function controls() {
    $('start').hidden = phase !== 'idle';
    $('stop').hidden = !active();
    $('review').hidden = phase !== 'review';
    for (const field of ['side','target','new']) $(field).disabled = phase !== 'idle';
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
        details.append(element('summary', `${set.side} · ${when} · ${set.reps.length}/${set.target}`));
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
    if (detector?.active && phase === 'scored') draft.state += ' · unfinished raise excluded';
    phase = 'review';
    controls();
    showSet($('result'), draft);
    status(reason === 'Complete' ? 'Capture complete. Enter both athlete ratings.' : reason);
  }

  function arm(next, now) {
    phase = next;
    readyAfter = now + 3000;
    deadline = now + 12000;
    poses = [];
    rates = [];
    status(next === 'arm-practice'
      ? 'Keep the leg still. Wait for the practice cue.'
      : 'Practice complete. Keep the leg at rest and wait for the scored raises cue.');
  }

  function onPose(event) {
    if (!active() || !validOrientation(event.alpha, event.beta, event.gamma)) return;
    const time = performance.now();
    const pose = {time, ...legPitch(rotationMatrix(event.alpha, event.beta, event.gamma))};
    if (phase.startsWith('arm-')) {
      poses.push(pose);
      poses = poses.filter(sample => sample.time >= time - 650);
      const rest = stableZero(poses, rates.filter(rate => rate.time >= time - 650), time);
      if (time < readyAfter || rest === null) return;
      if (phase === 'arm-practice') zero = rest;
      else if (Math.abs(wrap180(rest - zero)) > 5) {
        status('Start position shifted after practice. Return to the original position or stop and remount.');
        return;
      }
      detector = phase === 'arm-practice' ? new Repetitions(10, 8) : new Repetitions();
      detector.push({time, angle: 0, offAxis: pose.offAxis});
      rates = [];
      phase = phase === 'arm-practice' ? 'practice' : 'scored';
      deadline = time + (phase === 'practice' ? 16000 : 45000);
      status(phase === 'practice' ? 'Go · one submaximal practice raise.' : `Go · 0/${draft.target} scored raises.`);
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
    if (phase === 'practice') {
      const axis = resolveAxis(rep, rates);
      const measured = axis ? addVelocity(rep, rates.map(rate => projectRate(rate, axis))) : null;
      draft.axis = Number.isFinite(measured?.speed) ? axis : null;
      draft.practiceFlags = measured?.flags ?? rep.flags;
      draft.practiceGyroStatus = draft.axis ? 'Verified' : measured ? 'Insufficient gyro sampling or peak' : 'Axis unverified';
      draft.practiceOffAxis = rep.offAxis;
      draft.practiceOffAxisSpeed = measured?.offAxisSpeed;
      if (rep.flags.includes('No return to baseline')) {
        finish('Practice did not return to the start. Return the leg to rest and start a new set.');
      } else {
        arm('arm-scored', time);
      }
      return;
    }
    draft.reps.push(draft.axis
      ? addVelocity(rep, rates.map(rate => projectRate(rate, draft.axis)))
      : addOrientationVelocity(rep));
    if (draft.reps.length === draft.target) {
      beep();
      finish('Complete');
    } else {
      status(`${draft.reps.length}/${draft.target} scored raises · continue when ready.`);
    }
  }

  $('start').addEventListener('click', () => {
    if (!sensorsEnabled()) {
      status('Use Enable above and grant motion access first.');
      return;
    }
    prepareAudio();
    $('review').reset();
    draft = {session, id: id(), started: new Date().toISOString(),
      side: $('side').value, target: Number($('target').value), reps: [],
      practiceFlags: ['Practice not completed']};
    detector = null;
    zero = undefined;
    arm('arm-practice', performance.now());
    controls();
    timer = setInterval(() => {
      const now = performance.now();
      if (!phase.startsWith('arm-') && now - detector.last.time > 500) {
        finish('Interrupted · orientation stream gap');
      } else if (now > deadline) {
        finish(phase.startsWith('arm-')
          ? 'Could not zero. Hold the leg still at the starting position and check sensor access.'
          : phase === 'practice'
            ? 'Practice raise was not detected. After the cue, lift the leg at least 10° and return to the start.'
            : 'Capture timed out');
      }
    }, 200);
  });
  $('stop').addEventListener('click', () => finish('Stopped by operator'));
  $('target').addEventListener('change', () => { $('protocol-note').hidden = $('target').value === '3'; });
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
    if (phase !== 'review' || !$('review').reportValidity()) return;
    try {
      const history = readHistory();
      localStorage.setItem(KEY, JSON.stringify([...history, {
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
