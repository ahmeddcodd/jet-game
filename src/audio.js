// audio.js — procedural sound via Web Audio API (no external files)
// Engine drone, gunfire, missile launch, explosions, hit, UI blips.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this._engineNodes = null;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.enabled = true;
    } catch (e) {
      console.warn('Audio unavailable', e);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // ---- Continuous engine drone, pitch tracks throttle ----
  startEngine() {
    if (!this.enabled || this._engineNodes) return;
    const ctx = this.ctx;
    // Two oscillators + noise for a jet-ish wash
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 70;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 105;

    const noise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    noise.buffer = buf; noise.loop = true;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 600;

    const gain = ctx.createGain();
    gain.gain.value = 0.12;

    osc1.connect(filt); osc2.connect(filt); noise.connect(filt);
    filt.connect(gain); gain.connect(this.master);
    osc1.start(); osc2.start(); noise.start();
    this._engineNodes = { osc1, osc2, filt, gain };
  }

  updateEngine(throttle, boost) {
    if (!this._engineNodes) return;
    const base = 60 + throttle * 90 + (boost ? 40 : 0);
    this._engineNodes.osc1.frequency.setTargetAtTime(base, this.ctx.currentTime, 0.05);
    this._engineNodes.osc2.frequency.setTargetAtTime(base * 1.5, this.ctx.currentTime, 0.05);
    this._engineNodes.filt.frequency.setTargetAtTime(400 + throttle * 1200 + (boost ? 500 : 0), this.ctx.currentTime, 0.05);
    this._engineNodes.gain.gain.setTargetAtTime(0.08 + throttle * 0.08 + (boost ? 0.06 : 0), this.ctx.currentTime, 0.1);
  }

  stopEngine() {
    if (!this._engineNodes) return;
    try {
      this._engineNodes.osc1.stop();
      this._engineNodes.osc2.stop();
    } catch (e) {}
    this._engineNodes = null;
  }

  // ---- One-shot sounds ----
  _blip(freq, dur, type = 'square', vol = 0.2, slideTo = null) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(g); g.connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  }

  _noise(dur, vol, filterType = 'lowpass', freqStart = 800, freqEnd = 200) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type = filterType;
    filt.frequency.setValueAtTime(freqStart, ctx.currentTime);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur);
  }

  gun() { this._noise(0.08, 0.25, 'bandpass', 1800, 600); this._blip(220, 0.05, 'square', 0.12, 110); }
  missile() { this._noise(0.5, 0.3, 'lowpass', 1200, 80); this._blip(800, 0.4, 'sawtooth', 0.15, 200); }
  explosion() { this._noise(0.9, 0.5, 'lowpass', 500, 40); this._blip(80, 0.5, 'sine', 0.3, 30); }
  hit() { this._blip(1200, 0.05, 'square', 0.1, 600); }
  playerHit() { this._noise(0.3, 0.35, 'lowpass', 700, 120); this._blip(160, 0.2, 'sawtooth', 0.2, 60); }
  uiConfirm() { this._blip(660, 0.08, 'square', 0.18, 990); }
  uiHover() { this._blip(440, 0.05, 'square', 0.08); }
  waveStart() {
    this._blip(330, 0.18, 'square', 0.18);
    setTimeout(() => this._blip(495, 0.18, 'square', 0.18), 160);
    setTimeout(() => this._blip(660, 0.3, 'square', 0.2), 320);
  }
  gameOver() {
    this._blip(440, 0.3, 'sawtooth', 0.2, 220);
    setTimeout(() => this._blip(330, 0.4, 'sawtooth', 0.2, 110), 250);
    setTimeout(() => this._blip(220, 0.7, 'sawtooth', 0.22, 55), 550);
  }
}
