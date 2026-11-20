import {deg, wrap180} from './math.js';

// Provisional engineering limits for browser-delivered samples, not clinical cut-offs.
export const MIN_SAMPLE_HZ = 30;
export const MAX_SAMPLE_GAP_MS = 50;

export function legPitch(matrix) {
  const [x, y, z] = matrix[2];
  return {pitch: deg(Math.atan2(y, z)), offAxis: deg(Math.asin(Math.min(1, Math.abs(x))))};
}

export function angularRate(event) {
  const {alpha, beta, gamma} = event.rotationRate ?? {};
  return [alpha, beta, gamma].every(Number.isFinite) ? {alpha, beta, gamma} : null;
}

const AXES = ['alpha', 'beta', 'gamma'];

export function samplingStats(samples, start, end) {
  const times = samples.map(sample => sample.time).filter(time => time >= start && time <= end);
  let largestGap = times.length ? Math.max(times[0] - start, end - times.at(-1)) : end - start;
  let ordered = true;
  for (let i = 1; i < times.length; i++) {
    const interval = times[i] - times[i - 1];
    if (interval <= 0) ordered = false;
    largestGap = Math.max(largestGap, interval);
  }
  const span = times.at(-1) - times[0];
  const hz = times.length >= 2 && span > 0 && ordered ? (times.length - 1) * 1000 / span : null;
  return {count: times.length, hz, minHz: largestGap > 0 ? 1000 / largestGap : null, gap: largestGap};
}

export function resolveAxis(rep, rates) {
  // Match gyroscope channels to the first recorded raise that supports verification.
  // This raise contributes to the results, including when verification fails.
  const motion = rates.filter(rate => rate.time >= rep.start && rate.time <= rep.end);
  const integrate = (channel, start, end) => {
    let total = 0;
    for (let i = 1; i < motion.length; i++) {
      const left = motion[i - 1], right = motion[i];
      const overlap = Math.min(end, right.time) - Math.max(start, left.time);
      if (overlap > 0) total += (left[channel] + right[channel]) * overlap / 2000;
    }
    return total;
  };
  const candidates = AXES.map(channel => ({
    channel, up: integrate(channel, rep.start, rep.peakTime),
    down: integrate(channel, rep.peakTime, rep.end)
  })).sort((a,b) => Math.abs(b.up) - Math.abs(a.up));
  const [first, second] = candidates;
  const sign = Math.sign(first.up);
  const fraction = Math.abs(first.up) / rep.peak;
  if (fraction < .5 || fraction > 1.6 || Math.abs(first.up) < 2 * Math.abs(second.up) ||
      -sign * first.down < .35 * rep.peak || -sign * first.down > 1.6 * rep.peak) return null;
  return {channel: first.channel, sign};
}

export function projectRate(rate, {channel, sign}) {
  return {time: rate.time, flexion: sign * rate[channel],
    other: Math.hypot(...AXES.filter(axis => axis !== channel).map(axis => rate[axis]))};
}

const OFF_AXIS_FLAGS = ['Off-axis orientation', 'Off-axis rotation'];
export const captureFlags = flags => flags.filter(flag => !OFF_AXIS_FLAGS.includes(flag));

export class Repetitions {
  leadIn = [];
  active = null;
  reps = [];
  last = null;
  rest = false;

  push(sample) {
    const {time, angle, offAxis} = sample;
    const previous = this.last;
    this.last = sample;
    if (!this.active) {
      if (Math.abs(angle) <= 6) this.rest = true;
      if (!this.rest) return null;
      if (angle < 10) {
        this.leadIn = [...this.leadIn.filter(pose => time - pose.time < 100), sample];
        return null;
      }
      this.rest = false;
      this.active = {start: previous?.time ?? time, peak: 0, offAxis: 0, trace: this.leadIn};
      if (previous && this.active.trace.at(-1)?.time !== previous.time) this.active.trace.push(previous);
      this.leadIn = [];
    }
    const rep = this.active;
    rep.trace.push(sample);
    if (angle > rep.peak) {
      rep.peak = angle;
      rep.peakTime = time;
    }
    rep.offAxis = Math.max(rep.offAxis, offAxis);
    const returned = Math.abs(angle) <= 6;
    if (!returned && time - rep.start < 5000) return null;
    this.active = null;
    this.rest = returned;
    if (returned) this.leadIn = [sample];
    if (rep.peak < 20 && returned) return null;
    const duration = time - rep.start;
    const sampling = samplingStats(rep.trace, rep.start, time);
    const flags = [];
    if (!returned) flags.push('No return to baseline');
    if (rep.peak < 20) flags.push('Small excursion');
    if (rep.offAxis > 15) flags.push('Off-axis orientation');
    if (sampling.gap > MAX_SAMPLE_GAP_MS) flags.push('Orientation gap');
    if (sampling.hz === null || sampling.hz < MIN_SAMPLE_HZ || sampling.count < 5) flags.push('Sparse orientation');
    const result = {...rep, end: time, duration, flags, samples: sampling.count,
      orientationHz: sampling.hz, orientationMinHz: sampling.minHz, gap: sampling.gap};
    this.reps.push(result);
    return result;
  }
}

function gyroMetrics(rep, rates) {
  const stats = samplingStats(rates, rep.start, rep.end);
  return {gyroSamples: stats.count, gyroHz: stats.hz, gyroMinHz: stats.minHz, gyroGap: stats.gap};
}

export function addVelocity({trace, ...rep}, rates) {
  const inside = rates.filter(rate => rate.time >= rep.start && rate.time <= rep.end);
  const peak = inside.reduce((max, rate) => rate.time <= rep.peakTime + 40 ? Math.max(max, rate.flexion) : max, 0);
  const sampling = gyroMetrics(rep, rates);
  const flags = [...rep.flags];
  if (sampling.gyroHz === null || sampling.gyroHz < MIN_SAMPLE_HZ || sampling.gyroSamples < 5) flags.push('Sparse gyroscope');
  if (sampling.gyroGap > MAX_SAMPLE_GAP_MS) flags.push('Gyroscope gap');
  const offAxisSpeed = inside.length ? inside.reduce((max, rate) => Math.max(max, rate.other), 0) : null;
  if (offAxisSpeed > Math.max(60, peak * 0.3)) flags.push('Off-axis rotation');
  if (!peak) flags.push('No positive gyroscope peak');
  return {...rep, ...sampling, flags, offAxisSpeed, speed: peak || null, speedSource: 'gyroscope'};
}

export function addOrientationVelocity({trace, ...rep}, rates = []) {
  const flags = [...rep.flags];
  let peak = 0;
  if (!flags.includes('Orientation gap') && !flags.includes('Sparse orientation')) {
    // Use 30–65 ms slopes during ascent to limit noise from frame-to-frame changes.
    for (let i = 1; i < trace.length && trace[i].time <= rep.peakTime; i++) {
      const end = trace[i];
      for (let j = i - 1; j >= 0; j--) {
        const start = trace[j];
        const span = end.time - start.time;
        if (span < 30) continue;
        if (span <= 65) peak = Math.max(peak, 1000 * (end.angle - start.angle) / span);
        break;
      }
    }
  }
  if (!peak) flags.push('Orientation velocity unavailable');
  return {...rep, ...gyroMetrics(rep, rates), flags, speed: peak || null, speedSource: 'orientation'};
}

export function measureRep(rep, rates, knownAxis) {
  const gyro = samplingStats(rates, rep.start, rep.end);
  const canVerify = gyro.hz >= MIN_SAMPLE_HZ && gyro.count >= 5 && gyro.gap <= MAX_SAMPLE_GAP_MS;
  const axis = knownAxis ?? (canVerify ? resolveAxis(rep, rates) : null);
  const result = axis
    ? addVelocity(rep, rates.map(rate => projectRate(rate, axis)))
    : addOrientationVelocity(rep, rates);
  return {...result, axis};
}

export function stableZero(samples, rates, now) {
  if (samples.length < 12 || samples[0].time > now - 450 || samples.at(-1).time < now - 100) return null;
  if (rates.some(rate => Math.hypot(rate.alpha, rate.beta, rate.gamma) > 12)) return null;
  const zero = samples[0].pitch;
  const tilt = samples[0].offAxis;
  if (Math.abs(zero) > 30 || tilt >= 70 || samples.some(sample =>
    Math.abs(sample.offAxis - tilt) > 3 || Math.abs(wrap180(sample.pitch - zero)) > 3)) return null;
  return zero + samples.reduce((sum, sample) => sum + wrap180(sample.pitch - zero), 0) / samples.length;
}

export function romUsable(rep) {
  return Number.isFinite(rep.peak) && !captureFlags(rep.flags).some(flag =>
    ['No return to baseline', 'Small excursion', 'Orientation gap', 'Sparse orientation'].includes(flag));
}

export function speedUsable(rep) {
  return romUsable(rep) && Number.isFinite(rep.speed) && !captureFlags(rep.flags).length;
}

export function selectedReps(reps, mode = 'all') {
  const indices = reps.map((_, index) => index);
  if (mode === 'last3') return indices.slice(-3);
  if (mode === 'fastest3') return indices.filter(index => speedUsable(reps[index]))
    .sort((a,b) => reps[b].speed - reps[a].speed || a - b).slice(0, 3).sort((a,b) => a - b);
  if (mode === 'rom3') return indices.filter(index => romUsable(reps[index]))
    .sort((a,b) => reps[b].peak - reps[a].peak || a - b).slice(0, 3).sort((a,b) => a - b);
  return indices;
}

export function summary(reps, mode = 'all') {
  const selected = selectedReps(reps, mode);
  const rom = selected.map(index => reps[index]).filter(romUsable).map(rep => rep.peak);
  const speed = selected.map(index => reps[index]).filter(speedUsable).map(rep => rep.speed);
  const mean = xs => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null;
  const max = xs => xs.length ? Math.max(...xs) : null;
  return {selected, validRom: rom.length, valid: speed.length,
    bestRom: max(rom), meanRom: mean(rom), bestSpeed: max(speed), meanSpeed: mean(speed)};
}
