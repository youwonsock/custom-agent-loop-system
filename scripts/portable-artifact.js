"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function compareNames(left, right) {
  return left < right ? -1 : (left > right ? 1 : 0);
}

function walkFiles(root) {
  const files = [];
  function visit(directory, relativeDirectory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Portable artifact contains an unsupported symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push({ absolute, relative: relative.replace(/\\/gu, "/") });
      else throw new Error(`Portable artifact contains an unsupported filesystem entry: ${relative}`);
    }
  }
  visit(root, "");
  return files.sort((left, right) => compareNames(left.relative, right.relative));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function summarizePortableDirectory(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Portable artifact directory does not exist: ${directory}`);
  }
  const hash = crypto.createHash("sha256");
  const files = walkFiles(directory);
  let bytes = 0;
  for (const file of files) {
    const fileBytes = fs.statSync(file.absolute).size;
    bytes += fileBytes;
    hash.update(file.relative);
    hash.update("\0");
    hash.update(sha256File(file.absolute));
    hash.update("\n");
  }
  return { sha256: hash.digest("hex"), bytes, fileCount: files.length, files };
}

function isPortableArtifactPath(candidate) {
  return fs.existsSync(candidate)
    && fs.statSync(candidate).isDirectory()
    && /^AgentLoopOrchestrator-\d+\.\d+\.\d+-win32-x64$/u.test(path.basename(candidate));
}

function artifactDigest(candidate) {
  return fs.statSync(candidate).isDirectory()
    ? summarizePortableDirectory(candidate).sha256
    : sha256File(candidate);
}

module.exports = {
  artifactDigest,
  isPortableArtifactPath,
  sha256File,
  summarizePortableDirectory,
  walkFiles,
};
