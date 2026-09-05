import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_SERVER_PORT, DEFAULT_WEB_DEV_PORT } from "@maolinc/cc-loom-shared";

const serverUrl = `http://localhost:${DEFAULT_SERVER_PORT}`;
const wsUrl = `ws://localhost:${DEFAULT_SERVER_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEFAULT_WEB_DEV_PORT,
    proxy: {
      "/api": serverUrl,
      "/ws": {
        target: wsUrl,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-ui": ["lucide-react"],
        },
      },
    },
  },
});
