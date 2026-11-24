// Fully generated Backrooms sound (Web Audio, no samples):
// fluorescent ballast hum that follows the lights around you, flicker
// crackle, damp-carpet footsteps, room tone, distant knocks, a muffled thud
// whenever the maze rearranges behind you, an HRTF-positioned entity, the
// EXIT sign's hum, heartbeat at low sanity, stings and a jumpscare.

type V3 = { x: number; y: number; z: number };

export class BackroomsAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private verb!: ConvolverNode;
  private verbSend!: GainNode;
  private noise!: AudioBuffer;
  private humGain!: GainNode;
  private humFilter!: BiquadFilterNode;
  private buzzGain!: GainNode;
  private toneGain!: GainNode;
  private entGain!: GainNode;
  private entPanner!: PannerNode;
  private entFilter!: BiquadFilterNode;
  private exitGain!: GainNode;
  private exitPanner!: PannerNode;
  private heartT = 0;
  private eventT = 8;
  private lastFlick = 1;
  volume = 0.9;

  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: "interactive" });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.linearRampToValueAtTime(this.volume, ctx.currentTime + 2.5);
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);

    // reverb: a carpeted, low-ceilinged office
    this.verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.8);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2) * (i < 200 ? i / 200 : 1);
    }
    this.verb.buffer = ir;
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.35;
    this.verbSend.connect(this.verb).connect(this.master);
    this.sfx.connect(this.verbSend);

    const n = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;

    // ---- fluorescent hum: 120 Hz mains buzz + harmonics + ballast hiss
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = "lowpass";
    this.humFilter.frequency.value = 1400;
    this.humFilter.connect(this.humGain).connect(this.master);
    for (const [f, type, g] of [
      [120, "sawtooth", 0.05],
      [240, "sine", 0.05],
      [360, "triangle", 0.025],
      [119.4, "sawtooth", 0.03],
    ] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(this.humFilter);
      o.start();
    }
    this.buzzGain = ctx.createGain();
    this.buzzGain.gain.value = 0;
    const hiss = this.loop();
    const hb = ctx.createBiquadFilter();
    hb.type = "bandpass";
    hb.frequency.value = 5200;
    hb.Q.value = 1.4;
    hiss.connect(hb).connect(this.buzzGain).connect(this.master);

    // ---- room tone: sub drone + very low filtered noise
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0.06;
    const drone = ctx.createOscillator();
    drone.frequency.value = 41;
    const dg = ctx.createGain();
    dg.gain.value = 0.25;
    drone.connect(dg).connect(this.toneGain);
    drone.start();
    const rn = this.loop();
    const rf = ctx.createBiquadFilter();
    rf.type = "lowpass";
    rf.frequency.value = 180;
    rn.connect(rf).connect(this.toneGain);
    this.toneGain.connect(this.master);

    // ---- the entity: wet, ragged breathing in 3D
    this.entPanner = this.panner();
    this.entGain = ctx.createGain();
    this.entGain.gain.value = 0;
    this.entFilter = ctx.createBiquadFilter();
    this.entFilter.type = "bandpass";
    this.entFilter.frequency.value = 700;
    this.entFilter.Q.value = 2.2;
    const breath = this.loop();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.33;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.5;
    const amp = ctx.createGain();
    amp.gain.value = 0.5;
    lfo.connect(lfoG).connect(amp.gain);
    lfo.start();
    breath.connect(this.entFilter).connect(amp).connect(this.entGain).connect(this.entPanner).connect(this.sfx);
    const growl = ctx.createOscillator();
    growl.type = "sawtooth";
    growl.frequency.value = 52;
    const gg = ctx.createGain();
    gg.gain.value = 0.18;
    const gf = ctx.createBiquadFilter();
    gf.type = "lowpass";
    gf.frequency.value = 220;
    growl.connect(gf).connect(gg).connect(amp);
    growl.start();

    // ---- exit sign hum (helps you home in on it)
    this.exitPanner = this.panner();
    this.exitGain = ctx.createGain();
    this.exitGain.gain.value = 0;
    const eo = ctx.createOscillator();
    eo.frequency.value = 180;
    eo.type = "triangle";
    const eo2 = ctx.createOscillator();
    eo2.frequency.value = 271;
    const eg2 = ctx.createGain();
    eg2.gain.value = 0.4;
    eo.connect(this.exitGain);
    eo2.connect(eg2).connect(this.exitGain);
    eo.start();
    eo2.start();
    this.exitGain.connect(this.exitPanner).connect(this.sfx);
  }

  private loop() {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, Math.random() * 2.5);
    return s;
  }

  private panner() {
    const p = this.ctx!.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "inverse";
    p.refDistance = 2;
    p.maxDistance = 60;
    p.rolloffFactor = 1.3;
    return p;
  }

  private burst(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = "bandpass", pan = 0, when = 0) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(this.sfx);
    s.start(t0, Math.random() * 2);
    s.stop(t0 + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", slideTo?: number, when = 0) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.sfx);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  footstep(run: boolean) {
    if (!this.ctx) return;
    const v = run ? 0.32 : 0.2;
    this.burst(0.16, 140 + Math.random() * 40, 0.8, v, "lowpass");
    this.burst(0.09, 900 + Math.random() * 500, 1.5, v * 0.35, "bandpass", (Math.random() - 0.5) * 0.3, 0.02);
  }

  /** Low muffled thud from the direction where the maze just rearranged. */
  shift(pan: number, strength: number) {
    if (!this.ctx) return;
    const g = Math.min(0.5, 0.12 + strength * 0.03);
    this.tone(55, 0.9, g, "sine", 28);
    this.burst(0.6, 120, 0.7, g * 0.6, "lowpass", Math.max(-1, Math.min(1, pan)));
  }

  crackle() {
    if (!this.ctx) return;
    this.burst(0.05, 3800, 3, 0.12);
    this.burst(0.03, 1200, 2, 0.08, "bandpass", 0, 0.03);
  }

  sting() {
    if (!this.ctx) return;
    for (const f of [92, 97.5, 138, 146.8, 196]) this.tone(f, 2.6, 0.06, "sawtooth");
    this.burst(1.5, 2400, 0.6, 0.18, "highpass");
  }

  gulp() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.tone(320 - i * 40, 0.12, 0.12, "sine", 180, i * 0.22);
  }

  jumpscare() {
    if (!this.ctx) return;
    this.burst(1.6, 1800, 0.3, 0.9, "highpass");
    this.burst(1.2, 400, 0.5, 0.7, "bandpass");
    this.tone(420, 1.4, 0.4, "sawtooth", 60);
    this.tone(433, 1.4, 0.35, "square", 52);
  }

  escape() {
    if (!this.ctx) return;
    this.burst(2.5, 6000, 0.4, 0.25, "highpass");
    for (const [f, w] of [
      [220, 0],
      [330, 0.15],
      [440, 0.3],
      [660, 0.45],
    ] as const)
      this.tone(f, 3, 0.1, "sine", f * 1.5, w);
  }

  private distantEvent() {
    const r = Math.random();
    const pan = Math.random() * 2 - 1;
    if (r < 0.4) {
      // knocks somewhere far away
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.burst(0.25, 160, 1.2, 0.07, "lowpass", pan, i * (0.32 + Math.random() * 0.1));
    } else if (r < 0.7) {
      // footsteps that are not yours
      for (let i = 0; i < 6; i++) this.burst(0.14, 150, 0.9, 0.04 * (1 - i / 8), "lowpass", pan, i * 0.48);
    } else if (r < 0.88) {
      // metal creak
      this.tone(80 + Math.random() * 40, 1.4, 0.035, "sawtooth", 140);
    } else {
      // a door slams
      this.burst(0.9, 90, 0.6, 0.12, "lowpass", pan);
    }
  }

  setListener(p: V3, fwd: V3) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02);
      L.positionY.setTargetAtTime(p.y, t, 0.02);
      L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      (L as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(p.x, p.y, p.z);
    }
  }

  update(
    dt: number,
    s: { light: number; flick: number; entity: V3 | null; entityDist: number; exit: V3 | null; sanity: number; paused: boolean; alive: boolean },
  ) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = s.paused ? 0.35 : 1;
    this.humGain.gain.setTargetAtTime((0.05 + 0.5 * s.light) * k, t, 0.08);
    this.buzzGain.gain.setTargetAtTime((0.004 + 0.02 * s.light) * k, t, 0.08);
    this.humFilter.frequency.setTargetAtTime(900 + 900 * s.light, t, 0.1);
    this.toneGain.gain.setTargetAtTime((0.05 + 0.05 * (1 - s.sanity)) * k, t, 0.5);
    if (s.flick < 0.4 && this.lastFlick >= 0.4 && !s.paused) this.crackle();
    this.lastFlick = s.flick;
    if (s.entity && s.alive) {
      const p = this.entPanner;
      p.positionX.setTargetAtTime(s.entity.x, t, 0.05);
      p.positionY.setTargetAtTime(s.entity.y, t, 0.05);
      p.positionZ.setTargetAtTime(s.entity.z, t, 0.05);
      const near = Math.max(0, 1 - s.entityDist / 22);
      this.entGain.gain.setTargetAtTime(near * near * 1.2 * k, t, 0.15);
      this.entFilter.frequency.setTargetAtTime(500 + 900 * near, t, 0.2);
    } else this.entGain.gain.setTargetAtTime(0, t, 0.2);
    if (s.exit) {
      const p = this.exitPanner;
      p.positionX.setTargetAtTime(s.exit.x, t, 0.05);
      p.positionY.setTargetAtTime(s.exit.y, t, 0.05);
      p.positionZ.setTargetAtTime(s.exit.z, t, 0.05);
      this.exitGain.gain.setTargetAtTime(0.06 * k, t, 0.3);
    } else this.exitGain.gain.setTargetAtTime(0, t, 0.3);
    this.master.gain.setTargetAtTime(this.volume, t, 0.3);
    if (!s.paused && s.alive) {
      // heartbeat below half sanity, faster as it falls
      if (s.sanity < 0.5) {
        this.heartT -= dt;
        if (this.heartT <= 0) {
          const g = 0.25 * (1 - s.sanity * 2);
          this.tone(52, 0.18, g, "sine", 40);
          this.tone(48, 0.16, g * 0.8, "sine", 38, 0.22);
          this.heartT = 0.5 + s.sanity * 1.4;
        }
      }
      this.eventT -= dt;
      if (this.eventT <= 0) {
        this.distantEvent();
        this.eventT = 9 + Math.random() * 18 * (0.4 + s.sanity);
      }
    }
  }
}
