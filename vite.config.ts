import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { apiPlugin } from "./server/api";

// `npm run dev:phone` serves HTTPS on the LAN: phones require a secure
// context for getUserMedia, so plain http://<mac-ip>:5173 cannot open the
// mic. Accept the self-signed certificate once on the phone.
const phoneMode = process.env.JV_HTTPS === "1";

export default defineConfig({
  plugins: [react(), apiPlugin(), ...(phoneMode ? [basicSsl()] : [])],
  server: { port: 5173, strictPort: true, host: phoneMode ? true : undefined },
  build: { target: "es2022" },
});
