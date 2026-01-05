import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 3000,
    proxy: {
      "/admin": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/account-limits": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
