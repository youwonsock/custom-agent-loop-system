import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
});
