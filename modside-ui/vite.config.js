import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/mod-side/ui/",
  plugins: [react()],
  build: {
    outDir: "../server/modside-ui-dist",
    emptyOutDir: true,
  },
});
