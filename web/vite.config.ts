import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const API_PREFIXES = ["/health", "/repos", "/sync", "/insights", "/narrative"] as const;
const DEFAULT_API_ORIGIN = "http://127.0.0.1:3000";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_ORIGIN || DEFAULT_API_ORIGIN;

  return {
    plugins: [react()],
    server: {
      proxy: Object.fromEntries(API_PREFIXES.map((path) => [path, { target, changeOrigin: true }])),
    },
  };
});
