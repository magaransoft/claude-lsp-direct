// adapters/eslint — in-process ESLint via require('eslint'). Daemon
// loads eslint once; each /call runs ESLint.lintText / ESLint.lintFiles
// against the warm engine.

'use strict';

function createAdapter({
  name = 'eslint-direct',
  markers = ['eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', 'package.json'],
  triggers = {
    soft: ['eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yml', '.eslintignore'],
    hard: ['.env', '.env.local', 'package.json'],
  },
} = {}) {
  return {
    name,
    markers,
    triggers,

    preload(workspace) {
      const paths = [workspace];
      try {
        const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
        if (globalRoot) paths.push(globalRoot);
      } catch { /* npm absent */ }
      try {
        const resolved = require.resolve('eslint', { paths });
        return require(resolved);
      } catch {
        return require('eslint');
      }
    },

    async call({ method, params }, ctx) {
      const p = params || {};
      const { ESLint } = ctx.pkg;
      switch (method) {
        case 'version':
          return { version: ctx.pkg.Linter ? new ctx.pkg.Linter().version : (ctx.pkg.VERSION || 'unknown') };
        case 'lint-text': {
          if (typeof p.source !== 'string') throw new Error('eslint.lint-text requires params.source (string)');
          const engine = getEngine(ctx, p.engineOptions);
          const results = await engine.lintText(p.source, p.filepath ? { filePath: p.filepath } : undefined);
          return { results };
        }
        case 'lint-files': {
          if (!Array.isArray(p.patterns) || p.patterns.length === 0) {
            throw new Error('eslint.lint-files requires params.patterns (non-empty array of globs)');
          }
          const engine = getEngine(ctx, p.engineOptions);
          const results = await engine.lintFiles(p.patterns);
          return { results };
        }
        case 'fix-text': {
          if (typeof p.source !== 'string') throw new Error('eslint.fix-text requires params.source (string)');
          const engine = getEngine(ctx, { ...(p.engineOptions || {}), fix: true });
          const results = await engine.lintText(p.source, p.filepath ? { filePath: p.filepath } : undefined);
          const output = results[0] && results[0].output ? results[0].output : p.source;
          return { output, changed: output !== p.source, results };
        }
        case 'format-results': {
          if (!Array.isArray(p.results)) throw new Error('eslint.format-results requires params.results (array)');
          const engine = getEngine(ctx, {});
          const formatter = await engine.loadFormatter(p.formatterName || 'stylish');
          return { formatted: formatter.format(p.results) };
        }
        default:
          throw new Error(`unknown eslint method: ${method} — supported: version, lint-text, lint-files, fix-text, format-results`);
      }
    },

    async reload(ctx) {
      // clear the ESLint instance so next call picks up the new config.
      ctx.state.delete('eslint-engine');
      ctx.log('eslint soft-reload: ESLint instance cleared; next call rebuilds with updated config');
    },
  };
}

function getEngine(ctx, engineOptions) {
  const { ESLint } = ctx.pkg;
  const cacheKey = 'eslint-engine:' + JSON.stringify(engineOptions || {});
  let engine = ctx.state.get(cacheKey);
  if (!engine) {
    engine = new ESLint({ cwd: ctx.workspace, ...(engineOptions || {}) });
    ctx.state.set(cacheKey, engine);
  }
  return engine;
}

module.exports = { createAdapter };
