// Minimal stand-in for MagicMirror's real `node_helper` module, which only
// resolves inside a full MagicMirror install.
module.exports = {
  create(definition) {
    return definition;
  }
};
