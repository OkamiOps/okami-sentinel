import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config";

const apiPort = Number(process.env.CSB_E2E_API_PORT);
if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
  throw new Error("CSB_E2E_API_PORT must be a valid local port");
}
const apiOrigin = `http://127.0.0.1:${apiPort}`;

/**
 * The production Vite config remains untouched. This test-only overlay points
 * the browser proxy at the API process created by the real E2E harness.
 */
export default mergeConfig(appConfig, defineConfig({
  server: {
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        // The browser lives on the random Vite port. This test-only proxy
        // presents the target's loopback origin so the real local-origin
        // guard is exercised without broadening its production allowlist.
        headers: { Origin: apiOrigin },
        rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
      },
    },
  },
}));
