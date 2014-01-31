/*global define*/
define("js-github", function () {
  "use strict";

  var normalizeAs = require('encoders').normalizeAs;
  var modes = require('modes');
  var hashAs = require('encoders').hashAs;
  var xhr = require('xhr');

  var binary = require('binary');

  var modeToType = {
    "040000": "tree",
    "100644": "blob",  // normal file
    "100655": "blob",  // executable file
    "120000": "blob",  // symlink
    "160000": "commit" // gitlink
  };

  var encoders = {
    commit: encodeCommit,
    tag: encodeTag,
    tree: encodeTree,
    blob: encodeBlob
  };

  var decoders = {
    commit: decodeCommit,
    tag: decodeTag,
    tree: decodeTree,
    blob: decodeBlob,
    text: decodeText
  };


  // Implement the js-git object interface using github APIs
  return function (repo, root, accessToken) {

    var apiRequest = xhr(root, accessToken);

    repo.loadAs = loadAs;         // (type, hash) -> value
    repo.saveAs = saveAs;         // (type, value) -> hash
    repo.readRef = readRef;       // (ref) -> hash
    repo.updateRef = updateRef;   // (ref, hash)
    repo.createTree = createTree; // (entries) -> hash

    function loadAs(type, hash, callback) {
      if (!callback) return loadAs.bind(null, type, hash);
      var typeName = type === "text" ? "blob" : type;
      apiRequest("GET", "/repos/:root/git/" + typeName + "s/" + hash, onValue);

      function onValue(err, result) {
        if (result === undefined) return callback(err);
        var body;
        try {
          body = decoders[type].call(repo, result);
        }
        catch (err) {
          return callback(err);
        }
        return callback(null, body, hash);
      }
    }

    function saveAs(type, body, callback) {
      if (!callback) return saveAs.bind(null, type, body);
      var request;
      try {
        body = normalizeAs(type, body);
        request = encoders[type](body);
      }
      catch (err) {
        return callback(err);
      }

      // Github doesn't allow creating empty trees.
      if (type === "tree" && request.tree.length === 0) {
        return callback(null, hashAs("tree", []), body);
      }
      var typeName = type === "text" ? "blobs" : type + "s";
      return apiRequest("POST", "/repos/:root/git/" + typeName, request, onWrite);

      function onWrite(err, result) {
        if (err) return callback(err);
        return callback(null, result.sha, body);
      }
    }

    // Create a tree with optional deep paths and create new blobs.
    // Entries is an array of {mode, path, hash|content}
    // Also deltas can be specified by setting entries.base to the hash of a tree
    // in delta mode, entries can be removed by specifying just {path}
    function createTree(entries, callback) {
      if (!callback) return createTree.bind(null, entries);
      var toDelete = entries.base && entries.filter(function (entry) {
        return !entry.mode;
      }).map(function (entry) {
        return entry.path;
      });
      if (toDelete && toDelete.length) return slowUpdateTree(entries, toDelete, callback);
      return fastUpdateTree(entries, callback);
    }

    function fastUpdateTree(entries, callback) {
      var request = { tree: entries.map(mapTreeEntry) };
      if (entries.base) request.base_tree = entries.base;

      apiRequest("POST", "/repos/:root/git/trees", request, onWrite);

      function onWrite(err, result) {
        if (err) return callback(err);
        return callback(null, result.sha);
      }
    }

    // Github doesn't support deleting entries via the createTree API, so we
    // need to manually create those affected trees and modify the request.
    function slowUpdateTree(entries, toDelete, callback) {
      callback = singleCall(callback);
      var root = entries.base;

      var left = 0;

      // Calculate trees that need to be re-built and save any provided content.
      var parents = {};
      toDelete.forEach(function (path) {
        var parentPath = path.substr(0, path.lastIndexOf("/"));
        var parent = parents[parentPath] || (parents[parentPath] = {
          add: {}, del: []
        });
        var name = path.substr(path.lastIndexOf("/") + 1);
        parent.del.push(name);
      });
      var other = entries.filter(function (entry) {
        if (!entry.mode) return false;
        var parentPath = entry.path.substr(0, entry.path.lastIndexOf("/"));
        var parent = parents[parentPath];
        if (!parent) return true;
        var name = entry.path.substr(entry.path.lastIndexOf("/") + 1);
        if (entry.hash) {
          parent.add.push({
            name: name,
            mode: entry.mode,
            hash: entry.hash
          });
          return false;
        }
        left++;
        repo.saveAs("blob", entry.content, function(err, hash) {
          if (err) return callback(err);
          parent.add[name] = {
            mode: entry.mode,
            hash: hash
          };
          if (!--left) onParents();
        });
        return false;
      });
      if (!left) onParents();

      function onParents() {
        Object.keys(parents).forEach(function (parentPath) {
          left++;
          // TODO: remove this dependency on pathToEntry
          repo.pathToEntry(root, parentPath, function (err, entry) {
            if (err) return callback(err);
            var tree = entry.tree;
            var commands = parents[parentPath];
            commands.del.forEach(function (name) {
              delete tree[name];
            });
            for (var name in commands.add) {
              tree[name] = commands.add[name];
            }
            repo.saveAs("tree", tree, function (err, hash) {
              if (err) return callback(err);
              other.push({
                path: parentPath,
                hash: hash,
                mode: modes.tree
              });
              if (!--left) {
                other.base = entries.base;
                fastUpdateTree(other, callback);
              }
            });
          });
        });
      }
    }


    function readRef(ref, callback) {
      if (!callback) return readRef.bind(null, ref);
      if (!(/^refs\//).test(ref)) {
        return callback(new TypeError("Invalid ref: " + ref));
      }
      return apiRequest("GET", "/repos/:root/git/" + ref, onRef);

      function onRef(err, result) {
        if (result === undefined) return callback(err);
        return callback(null, result.object.sha);
      }
    }

    function updateRef(ref, hash, callback) {
      if (!callback) return updateRef(null, ref, hash);
      if (!(/^refs\//).test(ref)) {
        return callback(new Error("Invalid ref: " + ref));
      }
      return apiRequest("PATCH", "/repos/:root/git/" + ref, {
        sha: hash
      }, onResult);

      function onResult(err) {
        if (err) return callback(err);
        callback();
      }
    }

  };


  function mapTreeEntry(entry) {
    if (!entry.mode) throw new TypeError("Invalid entry");
    var mode = modeToString(entry.mode);
    var item = {
      path: entry.path,
      mode: mode,
      type: modeToType[mode]
    };
    if (entry.hash) item.sha = entry.hash;
    else item.content = entry.content;
    return  item;
  }

  function encodeCommit(commit) {
    var out = {};
    out.message = commit.message;
    out.tree = commit.tree;
    if (commit.parents) out.parents = commit.parents;
    else if (commit.parent) out.parents = [commit.parent];
    else commit.parents = [];
    if (commit.author) out.author = encodePerson(commit.author);
    if (commit.committer) out.committer = encodePerson(commit.committer);
    return out;
  }

  function encodeTag(tag) {
    return {
      tag: tag.tag,
      message: tag.message,
      object: tag.object,
      tagger: encodePerson(tag.tagger)
    };
  }

  function encodePerson(person) {
    return {
      name: person.name,
      email: person.email,
      date: (person.date || new Date()).toISOString()
    };
  }

  function encodeTree(tree) {
    return {
      tree: Object.keys(tree).map(function (name) {
        var entry = tree[name];
        var mode = modeToString(entry.mode);
        return {
          path: name,
          mode: mode,
          type: modeToType[mode],
          sha: entry.hash
        };
      })
    };
  }

  function encodeBlob(blob) {
    if (typeof blob === "string") return {
      content: binary.encodeUtf8(blob),
      encoding: "utf-8"
    };
    if (binary.isBinary(blob)) return {
      content: binary.toBase64(blob),
      encoding: "base64"
    };
    throw new TypeError("Invalid blob type, must be binary of string");
  }

  function modeToString(mode) {
    var string = mode.toString(8);
    // Github likes all modes to be 6 chars long
    if (string.length === 5) string = "0" + string;
    return string;
  }

  function decodeCommit(result) {
    return {
      tree: result.tree.sha,
      parents: result.parents.map(function (object) {
        return object.sha;
      }),
      author: pickPerson(result.author),
      committer: pickPerson(result.committer),
      message: result.message
    };
  }

  function decodeTag(result) {
    return {
      object: result.object.sha,
      type: result.object.type,
      tag: result.tag,
      tagger: pickPerson(result.tagger),
      message: result.message
    };
  }

  function decodeTree(result) {
    var tree = {};
    result.tree.forEach(function (entry) {
      tree[entry.path] = {
        mode: parseInt(entry.mode, 8),
        hash: entry.sha
      };
    });
    return tree;
  }

  function decodeBlob(result) {
    if (result.encoding === 'base64') {
      return binary.fromBase64(result.content.replace(/\n/g, ''));
    }
    if (result.encoding === 'utf-8') {
      return binary.fromUtf8(result.content);
    }
    throw new Error("Unknown blob encoding: " + result.encoding);
  }

  function decodeText(result) {
    if (result.encoding === 'base64') {
      return binary.decodeBase64(result.content.replace(/\n/g, ''));
    }
    if (result.encoding === 'utf-8') {
      return result.content;
    }
    throw new Error("Unknown blob encoding: " + result.encoding);
  }

  function pickPerson(person) {
    return {
      name: person.name,
      email: person.email,
      date: parseDate(person.date)
    };
  }

  function parseDate(string) {
    // TODO: test this once GitHub adds timezone information
    var match = string.match(/-?[0-9]{2}:[0-9]{2}$/);
    var date = new Date(string);
    date.timeZoneOffset = 0;
    if (match) {
      date.timeZoneOffset = parseInt(match[0].replace(":30", ".5").replace(":00", ".0"), 10) * 60;
    }
    return date;
  }

  function singleCall(callback) {
    var done = false;
    return function () {
      if (done) return;
      done = true;
      return callback.apply(this, arguments);
    };
  }

});
