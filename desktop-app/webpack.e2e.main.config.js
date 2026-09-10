const path = require("node:path");
const base = require("./webpack.main.config");

module.exports = {
  ...base,
  output: {
    path: path.resolve(__dirname, ".e2e", "main"),
    filename: "[name].js",
    clean: true,
  },
};
