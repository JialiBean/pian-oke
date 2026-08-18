import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./server/api";

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
