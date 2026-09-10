const path = require("node:path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const base = require("./webpack.renderer.config");

module.exports = {
  ...base,
  output: {
    path: path.resolve(__dirname, ".e2e", "renderer"),
    filename: "renderer.js",
    clean: true,
  },
  plugins: [
    ...(base.plugins || []),
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, "src", "renderer", "index.html"),
      filename: "index.html",
    }),
  ],
};
