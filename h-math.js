import {deg, wrap180} from './math.js';

export function legPitch(matrix) {
  const [x, y, z] = matrix[2];
  return {pitch: deg(Math.atan2(y, z)), offAxis: deg(Math.asin(Math.min(1, Math.abs(x))))};
}

export function angularRate(event) {
  const {alpha, beta, gamma} = event.rotationRate ?? {};
  return [alpha, beta, gamma].every(Number.isFinite) ? {alpha, beta, gamma} : null;
}

const AXES = ['alpha', 'beta', 'gamma'];

export function resolveAxis(rep, rates) {
  // Compare device-motion channels against the known positive orientation change
  // during practice. Browser axis naming has varied across implementations.
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
  constructor(minPeak = 20, onset = 10) {
    this.minPeak = minPeak;
    this.onset = onset;
  }

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
      if (angle < this.onset) {
        this.leadIn = [...this.leadIn.filter(pose => time - pose.time < 100), sample];
        return null;
      }
      this.rest = false;
      this.active = {start: previous?.time ?? time, samples: 0, peak: 0, offAxis: 0, gap: 0, trace: this.leadIn};
      this.leadIn = [];
    }
    const rep = this.active;
    rep.samples++;
    rep.trace.push(sample);
    if (angle > rep.peak) {
      rep.peak = angle;
      rep.peakTime = time;
    }
    rep.offAxis = Math.max(rep.offAxis, offAxis);
    rep.gap = Math.max(rep.gap, previous ? time - previous.time : 0);
    const returned = Math.abs(angle) <= 6;
    if (!returned && time - rep.start < 5000) return null;
    this.active = null;
    this.rest = returned;
    if (returned) this.leadIn = [sample];
    if (rep.peak < this.minPeak && returned) return null;
    const duration = time - rep.start;
    const flags = [];
    if (!returned) flags.push('No return to baseline');
    if (rep.peak < this.minPeak) flags.push('Small excursion');
    if (rep.offAxis > 15) flags.push('Off-axis orientation');
    if (rep.gap > 100) flags.push('Orientation gap');
    if (rep.samples * 1000 / duration < 30 || rep.samples < 5) flags.push('Sparse orientation');
    const result = {...rep, end: time, duration, flags};
    this.reps.push(result);
    return result;
  }
}

export function addVelocity({trace, ...rep}, rates) {
  const inside = rates.filter(rate => rate.time >= rep.start && rate.time <= rep.end);
  const peak = inside.reduce((max, rate) => rate.time <= rep.peakTime + 40 ? Math.max(max, rate.flexion) : max, 0);
  const times = [rep.start, ...inside.map(rate => rate.time), rep.end];
  const gap = Math.max(...times.slice(1).map((time, index) => time - times[index]));
  const hz = inside.length * 1000 / rep.duration;
  const flags = [...rep.flags];
  if (hz < 30 || gap > 100) flags.push('Sparse gyroscope');
  const offAxisSpeed = inside.length ? inside.reduce((max, rate) => Math.max(max, rate.other), 0) : null;
  if (offAxisSpeed > Math.max(60, peak * 0.3)) flags.push('Off-axis rotation');
  if (!peak) flags.push('No positive gyroscope peak');
  return {...rep, flags, gyroHz: hz, gyroGap: gap, offAxisSpeed,
    speed: hz >= 30 && gap <= 100 && peak > 0 ? peak : null, speedSource: 'gyroscope'};
}

export function addOrientationVelocity({trace, ...rep}) {
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
  return {...rep, flags, speed: peak || null, speedSource: 'orientation'};
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

export function summary(reps) {
  const valid = reps.filter(rep => !captureFlags(rep.flags).length && Number.isFinite(rep.speed));
  const values = key => valid.map(rep => rep[key]);
  const mean = xs => xs.length ? xs.reduce((a,b) => a+b, 0) / xs.length : null;
  const max = xs => xs.length ? Math.max(...xs) : null;
  return {valid: valid.length, bestRom: max(values('peak')), meanRom: mean(values('peak')),
    bestSpeed: max(values('speed')), meanSpeed: mean(values('speed'))};
}
