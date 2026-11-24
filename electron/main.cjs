// Desktop shell for THE BACKROOMS (and HOLD THE STREET).
// Serves the Vite build over a privileged app:// scheme (ES modules, WASM and
// workers need a real origin; file:// is not enough), prefers the discrete GPU
// and never lets a GPU blocklist drop WebGL2 to software.

const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ---- GPU / performance switches (must be set before "ready")
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (process.env.BR_UNCAPPED) {
  // benchmarking: render as fast as possible
  app.commandLine.appendSwitch("disable-frame-rate-limit");
  app.commandLine.appendSwitch("disable-gpu-vsync");
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const DIST = path.join(__dirname, "..", "dist");
const ICON = path.join(__dirname, "..", "build", "icon.png");

function serveDist() {
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 480,
    backgroundColor: "#000000",
    show: false,
    autoHideMenuBar: true,
    title: "The Backrooms",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  const page = process.env.BR_PAGE || "index.html";
  const query = process.env.BR_QUERY ? `?${process.env.BR_QUERY}` : "";
  win.loadURL(`app://game/${page}${query}`);

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11" || (input.key === "Enter" && input.alt)) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
    if (input.key === "F12" && !app.isPackaged) win.webContents.toggleDevTools();
  });
  // keep navigation inside the game; real links open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) event.preventDefault();
  });

  // Smoke test hook: BR_SCREENSHOT=out.png captures the window after a delay and quits.
  if (process.env.BR_SCREENSHOT) {
    const delay = Number(process.env.BR_SCREENSHOT_DELAY || 12000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (process.env.BR_EVAL) await win.webContents.executeJavaScript(process.env.BR_EVAL);
          await new Promise((r) => setTimeout(r, Number(process.env.BR_EVAL_WAIT || 0)));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.BR_SCREENSHOT, img.toPNG());
          const info = await win.webContents.executeJavaScript(
            "JSON.stringify({ gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c && c.getExtension('WEBGL_debug_renderer_info'); return c ? (d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl2') : 'none'; })(), title: document.title })",
          );
          console.log(`[desktop] captured ${process.env.BR_SCREENSHOT} ${info}`);
        } catch (err) {
          console.error("[desktop] capture failed", err);
          process.exitCode = 1;
        }
        app.quit();
      }, delay);
    });
  }
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    serveDist();
    ipcMain.on("quit", () => app.quit());
    ipcMain.on("toggle-fullscreen", (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w) w.setFullScreen(!w.isFullScreen());
    });
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
