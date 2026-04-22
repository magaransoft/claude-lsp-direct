// adapters/prettier — in-process prettier via require('prettier').
// The daemon loads prettier once at init; every /call runs
// pkg.format() / pkg.check() / pkg.resolveConfig() against the warm
// package reference. Warm cost: one library-load at spawn; each call
// is pure CPU against the loaded module.

'use strict';

const fs = require('fs');

function createAdapter({
  name = 'prettier-direct',
  markers = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'package.json'],
  triggers = {
    soft: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', '.prettierignore'],
    hard: ['.env', '.env.local', 'package.json'],
  },
} = {}) {
  return {
    name,
    markers,
    triggers,

    preload(workspace) {
      // resolve prettier from the workspace node_modules first, then
      // the user's global npm root, then the script's own require path.
      const paths = [workspace];
      try {
        const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
        if (globalRoot) paths.push(globalRoot);
      } catch { /* npm absent — fall through */ }
      try {
        const resolved = require.resolve('prettier', { paths });
        return require(resolved);
      } catch {
        return require('prettier'); // final fallback; throws if nothing found
      }
    },

    async call({ method, params }, ctx) {
      const p = params || {};
      const prettier = ctx.pkg;
      switch (method) {
        case 'version':
          return { version: prettier.version };
        case 'format': {
          if (typeof p.source !== 'string') throw new Error('prettier.format requires params.source (string)');
          const options = { ...(p.options || {}) };
          if (p.filepath) options.filepath = p.filepath;
          const formatted = await prettier.format(p.source, options);
          return { formatted };
        }
        case 'check': {
          if (typeof p.source !== 'string') throw new Error('prettier.check requires params.source (string)');
          const options = { ...(p.options || {}) };
          if (p.filepath) options.filepath = p.filepath;
          const matches = await prettier.check(p.source, options);
          return { matches };
        }
        case 'format-file': {
          if (typeof p.filepath !== 'string') throw new Error('prettier.format-file requires params.filepath (string)');
          const source = fs.readFileSync(p.filepath, 'utf8');
          const config = await prettier.resolveConfig(p.filepath);
          const formatted = await prettier.format(source, { ...(config || {}), filepath: p.filepath });
          return { filepath: p.filepath, formatted, changed: formatted !== source };
        }
        case 'resolve-config': {
          if (typeof p.filepath !== 'string') throw new Error('prettier.resolve-config requires params.filepath (string)');
          const config = await prettier.resolveConfig(p.filepath);
          return { config };
        }
        default:
          throw new Error(`unknown prettier method: ${method} — supported: version, format, check, format-file, resolve-config`);
      }
    },

    async reload(ctx) {
      // prettier.resolveConfig honors the file system each call — no
      // explicit reload needed for config changes.
      ctx.log('prettier soft-reload: config re-read on next format call');
    },
  };
}

module.exports = { createAdapter };
