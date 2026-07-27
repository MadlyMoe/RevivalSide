import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
            return "react";
          }

          if (id.includes("node_modules/zod/")) {
            return "zod";
          }

          if (id.includes("node_modules/react-router") || id.includes("node_modules/@remix-run")) {
            return "router";
          }

          if (id.includes("node_modules/radix-ui/") || id.includes("node_modules/@radix-ui/")) {
            return "radix";
          }

          if (id.includes("node_modules/motion/")) {
            return "motion";
          }

          if (id.includes("node_modules/lucide-react/")) {
            return "icons";
          }
        },
      },
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
