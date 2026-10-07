// Runs OpenAI's Codex CLI (`codex exec`) so Buddy can use the user's ChatGPT sign-in
// instead of an API key. Codex runs read-only in an empty scratch folder and only
// returns text; Buddy applies any task changes itself.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runCli, cliError } = require('./cli');

// Kept for callers/tests that classify raw Codex output.
function codexError(stderr, { code, timedOut, spawnError } = {}) {
  return cliError('codex', { code, stderr, timedOut, notFound: spawnError === 'ENOENT' });
}

/**
 * Run one Codex turn and return its final message.
 * @param {{prompt: string, schema?: object, model?: string, workDir: string, timeoutMs?: number}} opts
 */
async function runCodex({ prompt, schema, model, workDir, timeoutMs = 180000 }) {
  fs.mkdirSync(workDir, { recursive: true });
  const id = crypto.randomBytes(4).toString('hex');
  const outFile = path.join(workDir, `out-${id}.txt`);
  const schemaFile = schema ? path.join(workDir, `schema-${id}.json`) : null;
  if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(schema));
  // --ignore-user-config: skip the user's own Codex setup (MCP servers, instructions, plugins).
  // Sign-in still comes from CODEX_HOME. This cut the prompt from ~16k to ~2k tokens per message.
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config',
    '--color', 'never', '-c', 'model_reasoning_effort=low', '-o', outFile];
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (model) args.push('-m', model);
  args.push('-'); // prompt from stdin
  try {
    const r = await runCli('codex', args, { input: prompt, cwd: workDir, timeoutMs });
    let out = '';
    try { out = fs.readFileSync(outFile, 'utf8').trim(); } catch (_) {}
    if (r.code === 0 && out) return out;
    throw cliError('codex', r);
  } finally {
    for (const f of [outFile, schemaFile]) if (f) fs.rm(f, { force: true }, () => {});
  }
}

module.exports = { runCodex, codexError };
