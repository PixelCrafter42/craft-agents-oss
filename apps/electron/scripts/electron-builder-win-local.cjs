const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const electronDir = path.resolve(__dirname, "..");
const baseConfigPath = path.join(electronDir, "electron-builder.yml");
const baseConfig = yaml.load(fs.readFileSync(baseConfigPath, "utf8"));

baseConfig.win = {
  ...(baseConfig.win || {}),
  signAndEditExecutable: false,
  signtoolOptions: {
    ...(baseConfig.win?.signtoolOptions || {}),
    sign: path.join(__dirname, "noop-win-sign.cjs"),
  },
};

baseConfig.afterPack = path.join(__dirname, "afterPack-win-local.cjs");

module.exports = baseConfig;
