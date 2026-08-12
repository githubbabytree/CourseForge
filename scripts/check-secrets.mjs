import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const candidateFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
).split("\0").filter(Boolean);

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/gi],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["credential assignment", /\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password|cookie)\s*[:=]\s*["']?([^\s"',;}]{12,})/gi],
  ["model endpoint assignment", /\b(?:llm|text_model|multimodal_model|openai)[_-]?(?:api|base)?[_-]?url\s*[:=]\s*["']?(https?:\/\/[^\s"',;}]+)/gi],
];

const isAllowedPlaceholder = (value) =>
  /^(?:change-me(?:-[a-z0-9._-]+)?|replace-(?:with-)?[a-z0-9._-]+|secret:\/\/[a-z0-9._/-]+|env:\/\/[a-z0-9._/-]+|https:\/\/example\.invalid(?:\/.*)?)$/i.test(value)
  || /^\$\{[A-Z][A-Z0-9_]*/.test(value)
  || /^\$[a-z_][a-z0-9_]*$/i.test(value)
  || /^(?:process\.env|env)\.[A-Z][A-Z0-9_]*$/i.test(value);

const credentialPattern = patterns.find(([label]) => label === "credential assignment")[1];
const scanCredentialFixture = (name, value) => {
  credentialPattern.lastIndex = 0;
  const match = `${name}=${value}`.matchAll(credentialPattern).next().value;
  return match?.[1];
};

// Keep the high-risk prefixed names covered without checking a secret-shaped
// literal into the repository. These assertions run in CI and local hooks.
const syntheticSecret = ["not", "a", "real", "credential", "value"].join("-");
for (const name of ["POSTGRES_PASSWORD", "BOOTSTRAP_ADMIN_PASSWORD", "ARTIFACT_S3_SECRET_KEY"]) {
  const candidate = scanCredentialFixture(name, syntheticSecret);
  if (candidate !== syntheticSecret || isAllowedPlaceholder(candidate)) {
    throw new Error(`secret scanner self-test failed for ${name}`);
  }
}
if (!isAllowedPlaceholder(scanCredentialFixture("POSTGRES_PASSWORD", "${POSTGRES_PASSWORD}"))) {
  throw new Error("secret scanner self-test rejected an environment reference");
}
const findings = [];

for (const file of candidateFiles) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  source.split(/\r?\n/).forEach((line, index) => {
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const candidate = match[1] ?? match[0];
        if (!isAllowedPlaceholder(candidate)) findings.push(`${file}:${index + 1}: ${label}`);
      }
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Secret scan passed (${candidateFiles.length} candidate files).\n`);
