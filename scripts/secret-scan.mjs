#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const rules = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  },
  {
    id: "openai-style-token",
    pattern: /(?<![A-Za-z0-9-])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "authorization-bearer",
    pattern: /authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    id: "credential-literal",
    pattern: /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|cookies?|password|secret|credentials?)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
];

const prohibitedPaths = [
  { id: "store-file", pattern: /(?:^|\/)store\.json$/i },
  { id: "database-file", pattern: /\.(?:db(?:-(?:wal|shm))?|sqlite3?)$/i },
  { id: "dependency-cache", pattern: /(?:^|\/)(?:node_modules|\.next|target|dist|dist-ssr|\.cache|cache|tmp|temp)(?:\/|$)/i },
];

const listed = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "buffer", windowsHide: true },
);

if (listed.status !== 0) {
  process.stderr.write("secret-scan: unable to enumerate repository files\n");
  process.exit(2);
}

const paths = listed.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const path of paths) {
  const normalizedPath = path.replaceAll("\\", "/");
  for (const rule of prohibitedPaths) {
    if (rule.pattern.test(normalizedPath)) findings.push({ path, rule: rule.id });
  }

  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    continue;
  }

  // Secret-bearing configuration and source files are textual. Skipping files
  // with NUL bytes avoids interpreting images, fonts, and archives as text.
  if (bytes.includes(0)) {
    continue;
  }

  const text = bytes.toString("utf8");
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      findings.push({ path, rule: rule.id });
    }
  }
}

if (findings.length > 0) {
  process.stderr.write("secret-scan: potential credentials detected (values redacted)\n");
  for (const finding of findings) {
    process.stderr.write(`- ${finding.rule}: ${finding.path}\n`);
  }
  process.exit(1);
}

process.stdout.write(`secret-scan: passed (${paths.length} repository files)\n`);
