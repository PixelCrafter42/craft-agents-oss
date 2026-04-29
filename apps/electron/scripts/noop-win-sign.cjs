async function sign() {
  // Local Windows test builds are unsigned. Returning without invoking signtool
  // still lets electron-builder run rcedit so exe resources (including icon)
  // are written correctly.
}

module.exports = sign;
module.exports.sign = sign;
