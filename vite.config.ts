import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        backrooms: fileURLToPath(new URL("./index.html", import.meta.url)),
        street: fileURLToPath(new URL("./street.html", import.meta.url)),
      },
    },
  },
  server: { host: true },
});
