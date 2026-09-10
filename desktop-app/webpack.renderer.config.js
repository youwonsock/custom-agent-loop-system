const path = require("node:path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
  entry: path.resolve(__dirname, "src/renderer.ts"),
  target: "web",
  module: {
    rules: [
      { test: /\.tsx?$/u, exclude: /node_modules/u, use: "ts-loader" },
      { test: /\.css$/u, use: [MiniCssExtractPlugin.loader, "css-loader"] },
    ],
  },
  plugins: [new MiniCssExtractPlugin({ filename: "[name].css" })],
  resolve: { extensions: [".ts", ".js"] },
};
