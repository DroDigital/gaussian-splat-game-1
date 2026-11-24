// Minimal, sandboxed bridge: lets the game's menus quit the app and toggle fullscreen.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  quit: () => ipcRenderer.send("quit"),
  toggleFullscreen: () => ipcRenderer.send("toggle-fullscreen"),
});
