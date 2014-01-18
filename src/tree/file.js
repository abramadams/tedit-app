/*global define*/
define("tree/file", function () {
  "use strict";

  var Node = require('tree/node');
  var editor = require('editor');

  function File() {
    Node.apply(this, arguments);
  }

  // Inherit from Node
  File.prototype = Object.create(Node.prototype, {
    constructor: { value: File }
  });

  File.prototype.onActivate = function (soft) {
    if (!soft) editor.focus();
  };

  return File;
});
