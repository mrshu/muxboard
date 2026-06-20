import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.mrshu.muxboard.sdPlugin";

/**
 * Bundles the plugin into a single CommonJS file the Stream Deck app launches.
 * Only src/plugin.ts and what it imports are bundled; core/ is dependency-free
 * and separately unit-tested via tsx without this build step.
 */
export default {
  input: "src/plugin.ts",
  output: {
    // .cjs so Node treats it as CommonJS regardless of package.json "type":
    // "module" (which is set for the ESM source/tests/scripts).
    file: `${sdPlugin}/bin/plugin.cjs`,
    format: "cjs",
    sourcemap: true,
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return relativeSourcePath;
    },
  },
  plugins: [
    typescript({ tsconfig: "./tsconfig.json" }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
  ],
  external: [],
};
