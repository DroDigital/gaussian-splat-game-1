// Camcorder OSD (REC, timecode, level, battery = stamina, sanity) and the
// title / pause / death / escape screens.

import type { QualityName } from "./config";

export interface HudActions {
  start: () => void;
  resume: () => void;
  restart: () => void;
  menu: () => void;
  next: () => void;
  quality: (q: QualityName) => void;
  quit?: () => void;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class BackroomsHud {
  private toastTimer = 0;
  constructor(a: HudActions, touch: boolean, desktop: boolean) {
    const ui = document.createElement("div");
    ui.id = "br-ui";
    ui.innerHTML = `
      <div id="osd" class="hidden">
        <div class="osd-tl"><span id="rec-dot">●</span> REC <span class="dim">SP</span><div id="tc">00:00:00</div></div>
        <div class="osd-tr"><div id="lvl">LEVEL 0</div><div class="batt"><div id="batt-fill"></div></div></div>
        <div class="osd-bl"><div class="dim small">SANITY</div><div class="sbar"><div id="san-fill"></div></div></div>
        <div class="osd-br dim" id="datestamp">OCT. 03 1994</div>
        <div id="dot"></div>
        <div id="msg"></div>
        <button id="br-pause" class="${touch ? "" : "hidden"}">II</button>
      </div>
      <div id="s-title" class="screen">
        <div class="panel">
          <h1>THE BACKROOMS</h1>
          <p class="sub">LEVEL 0 · procedurally generated</p>
          <p>You noclipped out of reality. The rooms rearrange whenever you look away, and the corridors ahead form as you walk into them. Find an <b class="exit">EXIT</b>. Keep it in sight. Don't let what follows you get close.</p>
          <div class="row" id="q-row"></div>
          <button id="b-start" class="primary" disabled>generating textures…</button>
          <p class="help dim small">${touch ? "left thumb: walk · right thumb: look · II: pause" : "WASD walk · Shift run · mouse look · Esc pause"}<br>almond water restores sanity · the exit hums</p>
          <div class="row small"><a href="./street.html" class="dim">hold the street →</a>${desktop ? `<button id="b-quit" class="link">quit</button>` : ""}</div>
        </div>
      </div>
      <div id="s-pause" class="screen hidden">
        <div class="panel">
          <h2>PAUSE</h2>
          <button id="b-resume" class="primary">resume</button>
          <div class="row" id="q-row2"></div>
          <button id="b-restart">restart level</button>
          <button id="b-menu">main menu</button>
          ${desktop ? `<button id="b-quit2">quit to desktop</button>` : ""}
        </div>
      </div>
      <div id="s-end" class="screen hidden">
        <div class="panel">
          <h2 id="end-title">YOU WERE FOUND</h2>
          <div class="stats">
            <div><span class="dim">survived</span><span id="end-time">0:00</span></div>
            <div><span class="dim">walked</span><span id="end-dist">0 m</span></div>
            <div><span class="dim">rooms rearranged</span><span id="end-shifts">0</span></div>
          </div>
          <button id="b-next" class="primary">go deeper</button>
          <button id="b-again">wake up again</button>
          <button id="b-menu2">main menu</button>
        </div>
      </div>
    `;
    document.body.appendChild(ui);
    $("b-start").onclick = () => a.start();
    $("b-resume").onclick = () => a.resume();
    $("b-restart").onclick = () => a.restart();
    $("b-again").onclick = () => a.restart();
    $("b-menu").onclick = () => a.menu();
    $("b-menu2").onclick = () => a.menu();
    $("b-next").onclick = () => a.next();
    $("br-pause").onclick = (e) => {
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent("br-pause"));
    };
    if (desktop && a.quit) {
      $("b-quit").onclick = () => a.quit!();
      $("b-quit2").onclick = () => a.quit!();
    }
    for (const rowId of ["q-row", "q-row2"]) {
      const row = $(rowId);
      row.innerHTML = `<span class="dim small">quality</span>`;
      for (const q of ["low", "medium", "high", "ultra"] as QualityName[]) {
        const b = document.createElement("button");
        b.className = "qbtn";
        b.dataset.q = q;
        b.textContent = q;
        b.onclick = () => a.quality(q);
        row.appendChild(b);
      }
    }
  }

  setQuality(q: QualityName) {
    for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".qbtn"))) b.classList.toggle("sel", b.dataset.q === q);
  }

  ready(text = "enter") {
    const b = $("b-start") as HTMLButtonElement;
    b.disabled = false;
    b.textContent = text;
  }

  show(screen: "title" | "pause" | "end" | null) {
    $("s-title").classList.toggle("hidden", screen !== "title");
    $("s-pause").classList.toggle("hidden", screen !== "pause");
    $("s-end").classList.toggle("hidden", screen !== "end");
    $("osd").classList.toggle("hidden", screen === "title");
  }

  update(s: { time: number; level: number; stamina: number; sanity: number; blink: boolean }) {
    const t = Math.floor(s.time);
    const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    $("tc").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    $("lvl").textContent = `LEVEL ${s.level}`;
    $("batt-fill").style.width = `${Math.round(s.stamina * 100)}%`;
    $("san-fill").style.width = `${Math.round(s.sanity * 100)}%`;
    $("san-fill").classList.toggle("low", s.sanity < 0.3);
    $("rec-dot").style.opacity = s.blink ? "1" : "0.15";
  }

  toast(text: string, seconds = 3) {
    const m = $("msg");
    m.textContent = text;
    m.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => m.classList.remove("on"), seconds * 1000);
  }

  showEnd(escaped: boolean, level: number, time: number, dist: number, shifts: number) {
    $("end-title").textContent = escaped ? `LEVEL ${level} · EXIT FOUND` : "YOU WERE FOUND";
    $("end-time").textContent = `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
    $("end-dist").textContent = `${Math.round(dist)} m`;
    $("end-shifts").textContent = shifts.toLocaleString();
    $("b-next").classList.toggle("hidden", !escaped);
    $("b-again").textContent = escaped ? "replay this level" : "wake up again";
    this.show("end");
  }
}
