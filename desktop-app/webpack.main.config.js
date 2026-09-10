const path = require("node:path");

module.exports = {
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
  entry: {
    main: path.resolve(__dirname, "src/main.ts"),
    preload: path.resolve(__dirname, "src/preload.ts"),
  },
  target: "electron-main",
  output: {
    // The main process and preload are separate entry points.  Forge's
    // webpack plugin otherwise gives both chunks the default `index.js`.
    filename: "[name].js",
  },
  module: {
    rules: [{ test: /\.tsx?$/u, exclude: /node_modules/u, use: "ts-loader" }],
  },
  resolve: { extensions: [".ts", ".js"] },
};
