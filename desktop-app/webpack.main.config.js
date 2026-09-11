const path = require("node:path");

module.exports = {
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
  // Forge resolves package.json's `.webpack/main` entry to the default
  // `index.js` output.  The renderer entry point owns preload bundling, so
  // keeping a second preload entry here would create an ambiguous packaged
  // layout and bypass Forge's renderer preload path.
  entry: path.resolve(__dirname, "src/main.ts"),
  target: "electron-main",
  module: {
    rules: [{ test: /\.tsx?$/u, exclude: /node_modules/u, use: "ts-loader" }],
  },
  resolve: { extensions: [".ts", ".js"] },
};
