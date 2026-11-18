// Minimal monospace HUD: anchor count, thin stability bar, timer, centre
// gaze-lock ring, toasts, and the title / pause / end / edit screens.

import { PRESETS } from "../world/presets";
import type { QualityName } from "../look";

export interface HudCallbacks {
  start: (presetId: string) => void;
  resume: () => void;
  restart: () => void;
  quality: (q: QualityName) => void;
  importFile: (f: File) => void;
  gyro: (on: boolean) => Promise<boolean>;
  editUndo: () => void;
  editClear: () => void;
  editNext: () => void;
  editScale: (k: number) => void;
  editFlip: () => void;
  next: () => void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export class Hud {
  root: HTMLDivElement;
  private ringArc: SVGCircleElement;
  private toastTimer = 0;
  quality: QualityName = "high";
  presetId = PRESETS[0].id;

  constructor(cb: HudCallbacks, touch: boolean) {
    this.root = document.createElement("div");
    this.root.id = "ui";
    this.root.innerHTML = `
      <div id="hud" class="hidden">
        <div class="tl">
          <div class="row"><span class="dim">anchors</span> <span id="anchors">0/5</span></div>
          <div class="bar"><div id="stabFill"></div><div class="tick"></div></div>
          <div class="row small"><span class="dim">stability</span> <span id="stabPct">100%</span></div>
        </div>
        <div class="tr">
          <div id="timer">3:00</div>
          <div class="small dim" id="levelName"></div>
        </div>
        <div id="reticle">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle cx="32" cy="32" r="22" class="ring-bg"/>
            <circle cx="32" cy="32" r="22" class="ring" id="ringArc" transform="rotate(-90 32 32)"/>
            <circle cx="32" cy="32" r="1.6" class="dot"/>
          </svg>
          <div id="aimLabel" class="small"></div>
        </div>
        <div id="toast"></div>
        <button id="pauseBtn" class="${touch ? "" : "hidden"}">II</button>
      </div>

      <div id="title" class="screen">
        <div class="panel">
          <div class="dim small">geo_splats / procedural street</div>
          <h1>HOLD THE STREET</h1>
          <p class="blurb">The street only holds together where you look. Find the five anchors before it dissolves.</p>
          <div id="presetList"></div>
          <div id="loadState" class="small dim">building street…</div>
          <button id="startBtn" class="primary" disabled>enter the street</button>
          <div class="help small dim">${
            touch
              ? "left thumb: walk · right thumb: look · tap II to pause"
              : "WASD walk · Shift run · mouse look · Esc pause<br>look at an anchor for 1.5 s to lock it"
          }</div>
          <label class="file small"><input type="file" id="fileTitle" accept=".spz,.ply,.splat,.ksplat,.sog,.zip"/> import scene (.spz .ply .splat .ksplat .sog)</label>
        </div>
      </div>

      <div id="pause" class="screen hidden">
        <div class="panel">
          <h2>paused</h2>
          <button id="resumeBtn" class="primary">resume</button>
          <div class="row q">quality
            <button data-q="high" class="qbtn">high · 1.5M</button>
            <button data-q="low" class="qbtn">low · 500k</button>
          </div>
          <label class="file"><input type="file" id="filePause" accept=".spz,.ply,.splat,.ksplat,.sog,.zip"/> import scene</label>
          <button id="restartBtn">restart</button>
          <div id="pausePresets"></div>
          <button id="gyroBtn" class="${touch ? "" : "hidden"}">gyro look: off</button>
        </div>
      </div>

      <div id="end" class="screen hidden">
        <div class="panel">
          <h2 id="endTitle">street held</h2>
          <div class="stats">
            <div><span class="dim">time</span> <span id="endTime">0:00</span></div>
            <div><span class="dim">stability</span> <span id="endStab">0%</span></div>
            <div><span class="dim">score</span> <span id="endScore">0</span></div>
          </div>
          <button id="nextBtn" class="primary">next street</button>
          <button id="againBtn">restart</button>
        </div>
      </div>

      <div id="edit" class="hidden">
        <div class="panel small">
          <div id="editTitle">draw the walkable area</div>
          <div id="editHelp" class="dim">click / tap on the overview to add polygon points</div>
          <div class="row">
            <button id="editUndo">undo</button>
            <button id="editClear">clear</button>
            <button id="editFlip">flip up</button>
            <span class="dim">scale</span>
            <button id="editScaleDown">−</button>
            <button id="editScaleUp">+</button>
          </div>
          <button id="editNext" class="primary">next</button>
        </div>
      </div>

      <div id="drop" class="hidden"><div>drop .spz / .ply / .splat / .ksplat / .sog</div></div>
    `;
    document.body.appendChild(this.root);
    this.ringArc = this.root.querySelector("#ringArc") as SVGCircleElement;

    const list = $("#presetList", this.root);
    const plist = $("#pausePresets", this.root);
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.className = "preset";
      b.dataset.id = p.id;
      b.innerHTML = `<b>${p.name}</b><span class="dim small">${p.blurb}</span>`;
      b.onclick = () => this.selectPreset(p.id);
      list.appendChild(b);
      const b2 = document.createElement("button");
      b2.textContent = `→ ${p.name.toLowerCase()}`;
      b2.onclick = () => cb.start(p.id);
      plist.appendChild(b2);
    }
    this.selectPreset(this.presetId);

    $("#startBtn", this.root).onclick = () => cb.start(this.presetId);
    $("#resumeBtn", this.root).onclick = () => cb.resume();
    $("#restartBtn", this.root).onclick = () => cb.restart();
    $("#againBtn", this.root).onclick = () => cb.restart();
    $("#nextBtn", this.root).onclick = () => cb.next();
    $("#pauseBtn", this.root).onclick = (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("hts-pause"));
    };
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".qbtn"))) {
      b.onclick = () => {
        this.setQuality(b.dataset.q as QualityName);
        cb.quality(this.quality);
      };
    }
    const gyroBtn = $("#gyroBtn", this.root);
    let gyro = false;
    gyroBtn.onclick = async () => {
      const ok = await cb.gyro(!gyro);
      gyro = !gyro && ok;
      gyroBtn.textContent = `gyro look: ${gyro ? "on" : "off"}`;
    };
    for (const id of ["#fileTitle", "#filePause"]) {
      const inp = $<HTMLInputElement>(id, this.root);
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (f) cb.importFile(f);
        inp.value = "";
      };
    }
    $("#editUndo", this.root).onclick = () => cb.editUndo();
    $("#editClear", this.root).onclick = () => cb.editClear();
    $("#editNext", this.root).onclick = () => cb.editNext();
    $("#editFlip", this.root).onclick = () => cb.editFlip();
    $("#editScaleDown", this.root).onclick = () => cb.editScale(1 / 1.15);
    $("#editScaleUp", this.root).onclick = () => cb.editScale(1.15);

    // drag & drop import anywhere
    const drop = $("#drop", this.root);
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.remove("hidden");
    });
    window.addEventListener("dragleave", (e) => {
      if (e.relatedTarget === null) drop.classList.add("hidden");
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.add("hidden");
      const f = e.dataTransfer?.files?.[0];
      if (f) cb.importFile(f);
    });
  }

  selectPreset(id: string) {
    this.presetId = id;
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".preset"))) b.classList.toggle("sel", b.dataset.id === id);
  }

  setQuality(q: QualityName) {
    this.quality = q;
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".qbtn"))) b.classList.toggle("sel", b.dataset.q === q);
  }

  show(screen: "title" | "pause" | "end" | "edit" | null) {
    for (const id of ["title", "pause", "end", "edit"]) $(`#${id}`, this.root).classList.toggle("hidden", id !== screen);
    $("#hud", this.root).classList.toggle("hidden", screen === "title" || screen === "edit");
  }

  setLoading(text: string, ready: boolean) {
    $("#loadState", this.root).textContent = text;
    ($("#startBtn", this.root) as HTMLButtonElement).disabled = !ready;
  }

  setLevelName(name: string) {
    $("#levelName", this.root).textContent = name.toLowerCase();
  }

  update(s: { locked: number; total: number; stability: number; timeLeft: number; lock: number; aimLabel: string; vortex: number }) {
    $("#anchors", this.root).textContent = `${s.locked}/${s.total}`;
    const pct = Math.round(s.stability * 100);
    const fill = $("#stabFill", this.root);
    fill.style.width = `${Math.max(0, Math.min(100, s.stability * 100))}%`;
    fill.classList.toggle("low", s.stability < 0.22);
    $("#stabPct", this.root).textContent = `${pct}%`;
    const m = Math.floor(s.timeLeft / 60), sec = Math.floor(s.timeLeft % 60);
    const timer = $("#timer", this.root);
    timer.textContent = `${m}:${sec.toString().padStart(2, "0")}`;
    timer.classList.toggle("low", s.timeLeft < 30);
    const C = 2 * Math.PI * 22;
    this.ringArc.style.strokeDasharray = `${C}`;
    this.ringArc.style.strokeDashoffset = `${C * (1 - s.lock)}`;
    $("#reticle", this.root).classList.toggle("active", s.lock > 0);
    $("#aimLabel", this.root).textContent = s.lock > 0 ? s.aimLabel : "";
    this.root.style.setProperty("--vortex", s.vortex.toFixed(3));
  }

  toast(text: string, seconds = 2.5) {
    const t = $("#toast", this.root);
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove("on"), seconds * 1000);
  }

  showEnd(won: boolean, time: number, stability: number, score: number) {
    $("#endTitle", this.root).textContent = won ? "street held" : "the street dissolved";
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    $("#endTime", this.root).textContent = `${m}:${s.toString().padStart(2, "0")}`;
    $("#endStab", this.root).textContent = `${Math.round(stability * 100)}%`;
    $("#endScore", this.root).textContent = won ? `${score}` : "—";
    $("#nextBtn", this.root).classList.toggle("hidden", !won);
    this.show("end");
  }

  setEdit(title: string, help: string, nextLabel: string) {
    $("#editTitle", this.root).textContent = title;
    $("#editHelp", this.root).textContent = help;
    $("#editNext", this.root).textContent = nextLabel;
  }
}
