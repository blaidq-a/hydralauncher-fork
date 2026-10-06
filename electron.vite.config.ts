import react from "@vitejs/plugin-react";
import {
  defineConfig,
  externalizeDepsPlugin,
  loadEnv,
  swcPlugin,
} from "electron-vite";
import { resolve } from "path";
import svgr from "vite-plugin-svgr";
import { scopeBigPictureCss } from "./src/big-picture/vite-scope-big-picture-css";

export default defineConfig(({ mode }) => {
  loadEnv(mode);

  process.env.MAIN_VITE_API_URL =
    process.env.MAIN_VITE_API_URL || "https://hydra-api-us-east-1.losbroxas.org";
  process.env.MAIN_VITE_AUTH_URL =
    process.env.MAIN_VITE_AUTH_URL || "https://auth.hydralauncher.gg";
  process.env.MAIN_VITE_CHECKOUT_URL =
    process.env.MAIN_VITE_CHECKOUT_URL || "https://checkout.hydralauncher.gg";

  return {
    main: {
      build: {
        sourcemap: true,
      },
      resolve: {
        alias: {
          "@main": resolve("src/main"),
          "@locales": resolve("src/locales"),
          "@resources": resolve("resources"),
          "@shared": resolve("src/shared"),
        },
      },
      plugins: [externalizeDepsPlugin(), swcPlugin()],
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
    },
    bigPicture: {
      root: "src/big-picture",
      build: {
        outDir: "out/big-picture",
        rollupOptions: {
          input: resolve("src/big-picture/index.html"),
        },
      },
      css: {
        postcss: {
          plugins: [scopeBigPictureCss()],
        },
      },
      resolve: {
        alias: {
          "@renderer": resolve("src/renderer/src"),
          "@locales": resolve("src/locales"),
          "@shared": resolve("src/shared"),
        },
      },
      plugins: [svgr(), react()],
    },
    renderer: {
      build: {
        sourcemap: true,
      },
      esbuild: {
        keepNames: true,
      },
      css: {
        postcss: {
          plugins: [scopeBigPictureCss()],
        },
        preprocessorOptions: {
          scss: {
            api: "modern",
          },
        },
      },
      resolve: {
        alias: {
          "@renderer": resolve("src/renderer/src"),
          "@locales": resolve("src/locales"),
          "@shared": resolve("src/shared"),
        },
      },
      plugins: [svgr(), react()],
    },
  };
});
