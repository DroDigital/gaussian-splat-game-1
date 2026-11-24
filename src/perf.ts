// Adaptive render resolution. Estimates the display refresh interval from the
// fastest recent frames, then lowers the render scale when frames run long and
// creeps back up when there is headroom. Hysteresis + cooldowns avoid flapping.

export class DynamicResolution {
  scale: number;
  private ema = 16.7;
  private ring = new Float32Array(120);
  private ri = 0;
  private refresh = 16.7;
  private overT = 0;
  private underT = 0;
  private cool = 1.5;
  enabled = true;

  constructor(
    public min: number,
    public max: number,
    start = max,
  ) {
    this.scale = Math.min(max, Math.max(min, start));
    this.ring.fill(16.7);
  }

  setRange(min: number, max: number) {
    this.min = min;
    this.max = max;
    this.scale = Math.min(max, Math.max(min, this.scale));
  }

  /** Feed one frame time (ms). Returns true when the scale changed. */
  sample(dtMs: number): boolean {
    if (!this.enabled || dtMs <= 0 || dtMs > 250) return false;
    const dt = dtMs / 1000;
    this.ring[this.ri++ % this.ring.length] = dtMs;
    if (this.ri % 30 === 0) {
      let m = Infinity;
      for (const v of this.ring) m = Math.min(m, v);
      this.refresh = Math.max(4, Math.min(34, m));
    }
    this.ema += (dtMs - this.ema) * 0.1;
    this.cool -= dt;
    if (this.ema > this.refresh * 1.22) {
      this.overT += dt;
      this.underT = 0;
    } else if (this.ema < this.refresh * 1.07) {
      this.underT += dt;
      this.overT = 0;
    } else {
      this.overT = 0;
      this.underT = 0;
    }
    if (this.cool > 0) return false;
    if (this.overT > 0.35 && this.scale > this.min) {
      // drop harder when far over budget
      const k = this.ema > this.refresh * 1.8 ? 0.8 : 0.9;
      this.scale = Math.max(this.min, this.scale * k);
      this.cool = 0.8;
      this.overT = 0;
      return true;
    }
    if (this.underT > 2.5 && this.scale < this.max) {
      this.scale = Math.min(this.max, this.scale * 1.06);
      this.cool = 1.6;
      this.underT = 0;
      return true;
    }
    return false;
  }

  get frameMs() {
    return this.ema;
  }
}
