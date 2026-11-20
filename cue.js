// Full-level, double pulse with short ramps to avoid clicks.
export function playCue(audio) {
  if (!audio || audio.state !== 'running') return;
  const start = audio.currentTime;
  for (const offset of [0, .3]) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = 1100;
    oscillator.connect(gain);
    gain.connect(audio.destination);
    const time = start + offset;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(.9, time + .015);
    gain.gain.setValueAtTime(.9, time + .2);
    gain.gain.linearRampToValueAtTime(0, time + .23);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(time);
    oscillator.stop(time + .24);
  }
}
