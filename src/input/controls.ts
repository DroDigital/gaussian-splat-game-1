// Desktop: WASD + Shift, mouse look with pointer lock, Esc pauses.
// Mobile: left virtual stick to walk, drag the right side to look, optional gyro.

export const isTouch = () => "ontouchstart" in window || navigator.maxTouchPoints > 0;

export class Controls {
  yaw = 0;
  pitch = 0;
  moveX = 0; // strafe -1..1
  moveZ = 0; // forward -1..1
  run = false;
  enabled = false;
  gyroOn = false;
  lookSensitivity = 0.0022;
  onPause: () => void = () => {};
  /** Fired on Esc/unlock and on touch "pause" button. */
  private keys = new Set<string>();
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private stickEl: HTMLDivElement;
  private knobEl: HTMLDivElement;
  private lastGyro: { a: number; b: number } | null = null;
  readonly touch = isTouch();

  constructor(private dom: HTMLElement) {
    this.stickEl = document.createElement("div");
    this.stickEl.className = "stick";
    this.knobEl = document.createElement("div");
    this.knobEl.className = "knob";
    this.stickEl.appendChild(this.knobEl);
    document.body.appendChild(this.stickEl);

    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.enabled && !document.pointerLockElement) this.onPause();
      this.keys.add(e.code);
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code) && this.enabled) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("mousemove", (e) => {
      if (!this.enabled || document.pointerLockElement !== this.dom) return;
      this.look(e.movementX, e.movementY);
    });
    document.addEventListener("pointerlockchange", () => {
      if (!document.pointerLockElement && this.enabled && !this.touch) this.onPause();
    });

    dom.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
    dom.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    dom.addEventListener("touchend", (e) => this.onTouchEnd(e));
    dom.addEventListener("touchcancel", (e) => this.onTouchEnd(e));
    window.addEventListener("deviceorientation", (e) => this.onGyro(e));
  }

  look(dx: number, dy: number) {
    this.yaw -= dx * this.lookSensitivity;
    this.pitch -= dy * this.lookSensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
  }

  requestLock() {
    if (this.touch) return;
    const p = this.dom.requestPointerLock?.() as unknown;
    if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  async enableGyro(on: boolean) {
    if (on) {
      const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
      if (typeof DOE.requestPermission === "function") {
        try {
          const r = await DOE.requestPermission();
          if (r !== "granted") return false;
        } catch {
          return false;
        }
      }
    }
    this.gyroOn = on;
    this.lastGyro = null;
    return on;
  }

  private onGyro(e: DeviceOrientationEvent) {
    if (!this.gyroOn || !this.enabled || e.alpha == null || e.beta == null) return;
    const a = e.alpha, b = e.beta;
    if (this.lastGyro) {
      let da = a - this.lastGyro.a;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      const landscape = Math.abs((screen.orientation?.angle ?? 0) % 180) === 90;
      this.yaw += (da * Math.PI) / 180;
      if (!landscape) this.pitch += ((b - this.lastGyro.b) * Math.PI) / 180;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
    }
    this.lastGyro = { a, b };
  }

  private onTouchStart(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth * 0.45 && this.stickId === null) {
        this.stickId = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        this.stickEl.style.display = "block";
        this.stickEl.style.left = `${t.clientX - 60}px`;
        this.stickEl.style.top = `${t.clientY - 60}px`;
        this.knobEl.style.transform = "translate(0px, 0px)";
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        let dx = t.clientX - this.stickOrigin.x, dy = t.clientY - this.stickOrigin.y;
        const l = Math.hypot(dx, dy), max = 50;
        if (l > max) {
          dx = (dx / l) * max;
          dy = (dy / l) * max;
        }
        this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
        this.moveX = dx / max;
        this.moveZ = -dy / max;
        this.run = l > max * 1.6;
      } else if (t.identifier === this.lookId) {
        const dx = t.clientX - this.lookLast.x, dy = t.clientY - this.lookLast.y;
        this.lookLast = { x: t.clientX, y: t.clientY };
        this.yaw -= dx * 0.0055;
        this.pitch -= dy * 0.0055;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      }
    }
  }

  private onTouchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null;
        this.moveX = 0;
        this.moveZ = 0;
        this.run = false;
        this.stickEl.style.display = "none";
      } else if (t.identifier === this.lookId) this.lookId = null;
    }
  }

  /** Movement intent in local space for this frame. */
  sample() {
    if (!this.enabled) return { x: 0, z: 0, run: false };
    let x = this.moveX, z = this.moveZ;
    const k = this.keys;
    if (k.has("KeyW") || k.has("ArrowUp")) z += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) z -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) x += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) x -= 1;
    const l = Math.hypot(x, z);
    if (l > 1) {
      x /= l;
      z /= l;
    }
    return { x, z, run: this.run || k.has("ShiftLeft") || k.has("ShiftRight") };
  }
}
