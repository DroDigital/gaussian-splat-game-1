// Generated city ambience with the Web Audio API: wind, a distant train,
// cicadas, and a low rumble that rises with the vortex. Zero audio assets.

export class Ambience {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private cicadaGain!: GainNode;
  private rumbleGain!: GainNode;
  private rumbleOsc!: OscillatorNode;
  private rumbleFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private nextTrain = 12;
  private t = 0;
  muted = false;

  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 3);
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // shared noise buffer (pink-ish)
    const len = ctx.sampleRate * 4;
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = this.noise.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
    }

    // wind: band-passed noise with slow gusting
    const wind = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.22;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);

    // cicadas: high band-passed noise, amplitude-modulated, slow swells
    const cic = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 5200;
    bp.Q.value = 6;
    const am = ctx.createGain();
    am.gain.value = 0.0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 38;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.5;
    const lfoOffset = ctx.createConstantSource();
    lfoOffset.offset.value = 0.5;
    lfo.connect(lfoGain).connect(am.gain);
    lfoOffset.connect(am.gain);
    lfo.start();
    lfoOffset.start();
    this.cicadaGain = ctx.createGain();
    this.cicadaGain.gain.value = 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.4;
    cic.connect(bp).connect(am).connect(this.cicadaGain).connect(pan).connect(this.master);

    // low rumble: sub sine + low-passed noise, rises with the vortex
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = "sine";
    this.rumbleOsc.frequency.value = 38;
    const rn = this.loopNoise();
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = "lowpass";
    this.rumbleFilter.frequency.value = 90;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.02;
    this.rumbleOsc.connect(this.rumbleGain);
    rn.connect(this.rumbleFilter).connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    this.rumbleOsc.start();
  }

  private loopNoise() {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random() * 2;
    src.start(0, Math.random() * 3);
    return src;
  }

  /** A distant train passing: filtered rumble + rhythmic wheel clacks, panned. */
  private train() {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const dur = 11;
    const src = this.loopNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.16, now + dur * 0.45);
    g.gain.linearRampToValueAtTime(0, now + dur);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(-0.8, now);
    pan.pan.linearRampToValueAtTime(0.8, now + dur);
    src.connect(lp).connect(g).connect(pan).connect(this.master);
    src.stop(now + dur + 0.1);
    // clacks
    for (let t = 0.3; t < dur - 0.3; t += 0.42 + (Math.floor(t / 0.42) % 2) * 0.13) {
      const c = this.loopNoise();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1400;
      bp.Q.value = 3;
      const cg = ctx.createGain();
      const env = Math.sin((t / dur) * Math.PI);
      cg.gain.setValueAtTime(0, now + t);
      cg.gain.linearRampToValueAtTime(0.05 * env, now + t + 0.005);
      cg.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.09);
      c.connect(bp).connect(cg).connect(pan);
      c.stop(now + t + 0.12);
    }
  }

  /** Soft bell when an anchor locks. */
  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    for (const [f, a] of [
      [880, 0.08],
      [1320, 0.04],
      [1760, 0.02],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(a, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
      o.connect(g).connect(this.master);
      o.start(now);
      o.stop(now + 2.3);
    }
  }

  update(dt: number, vortex: number, stability: number, paused: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    this.t += dt;
    const gust = 0.5 + 0.5 * Math.sin(this.t * 0.23) * Math.sin(this.t * 0.071 + 1.3);
    this.windGain.gain.setTargetAtTime((0.12 + 0.18 * gust + 0.35 * vortex + 0.08 * (1 - stability)) * (paused ? 0.4 : 1), now, 0.3);
    this.windFilter.frequency.setTargetAtTime(300 + 400 * gust + 900 * vortex, now, 0.3);
    const swell = 0.5 + 0.5 * Math.sin(this.t * 0.09);
    this.cicadaGain.gain.setTargetAtTime((0.025 + 0.05 * swell) * (1 - vortex) * (paused ? 0.4 : 1), now, 0.5);
    this.rumbleGain.gain.setTargetAtTime(0.015 + 0.5 * vortex * vortex + 0.04 * (1 - stability), now, 0.2);
    this.rumbleOsc.frequency.setTargetAtTime(34 + 18 * vortex, now, 0.3);
    this.rumbleFilter.frequency.setTargetAtTime(80 + 200 * vortex, now, 0.3);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, now, 0.2);
    if (!paused) {
      this.nextTrain -= dt;
      if (this.nextTrain <= 0) {
        this.train();
        this.nextTrain = 40 + Math.random() * 35;
      }
    }
  }
}
