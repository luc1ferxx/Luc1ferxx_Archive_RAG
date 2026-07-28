import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
  build: {
    outDir: "build",
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react";
          }

          if (/node_modules[\\/](antd|@ant-design|rc-[^\\/]+|@rc-component)[\\/]/.test(id)) {
            return "antd";
          }

          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/setupTests.js",
    css: false,
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
  },
});
