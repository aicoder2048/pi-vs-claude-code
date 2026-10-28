// damage-control.ts / damage-control-continue.ts 的检查逻辑复刻，05、06 两篇共用。
// 两个扩展的 tool_call 检查代码逐行相同（只差注释），所以只写一份；行号不同，由页面传入 L：
//   { zapPath, bashPattern, bashZap, bashRo, bashNoDelete, roPath } → “第 N–M 行”
// 规则取自 .pi/damage-control-rules.yaml：路径规则全收，bash 模式只收 14 条。
// path.resolve / path.relative 是简化的 POSIX 实现；cwd 固定 /Users/me/proj，home 固定 /Users/me。
(function () {
const HOME = '/Users/me', CWD = '/Users/me/proj';
const RULES = {
  bashToolPatterns: [
    { pattern: '\\brm\\s+(-[^\\s]*)*-[rRf]', reason: 'rm with recursive or force flags' },
    { pattern: '\\bsudo\\s+rm\\b', reason: 'sudo rm' },
    { pattern: '\\bchmod\\s+(-[^\\s]+\\s+)*777\\b', reason: 'chmod 777 (world writable)' },
    { pattern: '\\bgit\\s+reset\\s+--hard\\b', reason: 'git reset --hard (use --soft or stash)' },
    { pattern: '\\bgit\\s+clean\\s+(-[^\\s]*)*-[fd]', reason: 'git clean with force/directory flags' },
    { pattern: '\\bgit\\s+push\\s+.*--force(?!-with-lease)', reason: 'git push --force (use --force-with-lease)' },
    { pattern: '\\bgit\\s+push\\s+(-[^\\s]*)*-f\\b', reason: 'git push -f (use --force-with-lease)' },
    { pattern: '\\bgit\\s+stash\\s+clear\\b', reason: 'git stash clear (deletes ALL stashes)' },
    { pattern: '\\bgit\\s+checkout\\s+--\\s*\\.', reason: 'Discards all uncommitted changes', ask: true },
    { pattern: '\\bgit\\s+restore\\s+\\.', reason: 'Discards all uncommitted changes', ask: true },
    { pattern: '\\bgit\\s+stash\\s+drop\\b', reason: 'Permanently deletes a stash', ask: true },
    { pattern: '\\bgit\\s+branch\\s+(-[^\\s]*)*-D', reason: 'Force deletes branch (even if unmerged)', ask: true },
    { pattern: '\\bmkfs\\.', reason: 'filesystem format command' },
    { pattern: '\\bdd\\s+.*of=/dev/', reason: 'dd writing to device' },
  ],
  zeroAccessPaths: ['.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.test', '.env.*.local', '*.env',
    '~/.ssh/', '~/.gnupg/', '~/.aws/', '~/.config/gcloud/', '*-credentials.json', '*serviceAccount*.json', '*service-account*.json',
    '~/.azure/', '~/.kube/', 'kubeconfig', '*-secret.yaml', 'secrets.yaml', '~/.docker/', '*.pem', '*.key', '*.p12', '*.pfx',
    '*.tfstate', '*.tfstate.backup', '.terraform/', '.vercel/', '.netlify/', 'firebase-adminsdk*.json', 'serviceAccountKey.json',
    '.supabase/', '~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '.git-credentials', 'dump.sql', 'backup.sql', '*.dump'],
  readOnlyPaths: ['/etc/', '/usr/', '/bin/', '/sbin/', '/boot/', '/root/', '~/.bash_history', '~/.zsh_history', '~/.node_repl_history',
    '~/.bashrc', '~/.zshrc', '~/.profile', '~/.bash_profile', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Gemfile.lock',
    'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Cargo.lock', 'go.sum', 'flake.lock', 'bun.lockb', 'uv.lock', 'npm-shrinkwrap.json',
    '*.lock', '*.lockb', '*.min.js', '*.min.css', '*.bundle.js', '*.chunk.js', 'dist/', 'build/', '.next/', '.nuxt/', '.output/',
    '__pycache__/', '.venv/', 'venv/', 'target/'],
  noDeletePaths: ["~/.claude/","CLAUDE.md","LICENSE","LICENSE.*","COPYING","COPYING.*","NOTICE","PATENTS","README.md","README.*","CONTRIBUTING.md","CHANGELOG.md","CODE_OF_CONDUCT.md","SECURITY.md",".git/",".gitignore",".gitattributes",".gitmodules",".github/",".gitlab-ci.yml",".circleci/","Jenkinsfile",".travis.yml","azure-pipelines.yml","Dockerfile","Dockerfile.*","docker-compose.yml","docker-compose.*.yml",".dockerignore"],
};
// 简化的 POSIX path
function normalize(p) {
  const out = [];
  p.split('/').forEach(s => { if (!s || s === '.') return; if (s === '..') out.pop(); else out.push(s); });
  return '/' + out.join('/');
}
const isAbs = p => p.startsWith('/');
const resolve = (cwd, p) => normalize(isAbs(p) ? p : cwd + '/' + p);
const join = (a, b) => { const j = (a + '/' + b).replace(/\/+/g, '/'); return j; };
function relative(from, to) {
  const f = from.split('/').filter(Boolean), t = to.split('/').filter(Boolean);
  let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}
function resolvePath(p, cwd) { if (p.startsWith('~')) p = join(HOME, p.slice(1)); return resolve(cwd, p); }
const expandTilde = p => p.startsWith('~') ? join(HOME, p.slice(1)) : p;
function commandReferencesPath(command, pp) {
  if (!pp) return false;
  let idx = command.indexOf(pp);
  while (idx >= 0) { const after = command[idx + pp.length]; if (!after || !/[A-Za-z0-9_-]/.test(after)) return true; idx = command.indexOf(pp, idx + 1); }
  return false;
}
function isPathMatch(target, pattern, cwd) {
  const rp = pattern.startsWith('~') ? join(HOME, pattern.slice(1)) : pattern;
  if (rp.endsWith('/')) { const ap = isAbs(rp) ? rp : resolve(cwd, rp); return target.startsWith(ap); }
  const rx = rp.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${rx}$|^${rx}/|/${rx}$|/${rx}/`);
  const rel = relative(cwd, target);
  return regex.test(target) || regex.test(rel) || target.includes(rp) || rel.includes(rp);
}
// 返回 { reason, ask, step }：step 指出是哪一段代码判出来的
function check(tool, input, L) {
  let reason = null, ask = false, step = '';
  const paths = [];
  if (['read', 'write', 'edit'].includes(tool)) paths.push(input);
  else if (['grep', 'find', 'ls'].includes(tool)) paths.push(input || '.');
  for (const p of paths) {
    const r = resolvePath(p, CWD);
    for (const z of RULES.zeroAccessPaths) if (isPathMatch(r, z, CWD)) { return { reason: `Access to zero-access path restricted: ${z}`, ask, step: `${L.zapPath} · zeroAccessPaths（isPathMatch）` }; }
  }
  if (tool === 'bash') {
    const command = input;
    for (const rule of RULES.bashToolPatterns) if (new RegExp(rule.pattern).test(command)) { return { reason: rule.reason, ask: !!rule.ask, step: `${L.bashPattern} · bashToolPatterns /${rule.pattern}/` }; }
    for (const z of RULES.zeroAccessPaths) if (command.includes(z)) return { reason: `Bash command references zero-access path: ${z}`, ask, step: `${L.bashZap} · zeroAccessPaths（字面 includes）` };
    for (const r of RULES.readOnlyPaths) {
      if (command.includes(r) && (/[\s>|]/.test(command) || command.includes('rm') || command.includes('mv') || command.includes('sed'))) {
        return { reason: `Bash command may modify read-only path: ${r}`, ask, step: `${L.bashRo} · readOnlyPaths（启发式）` };
      }
    }
    if (/\brm\b/.test(command) || /\bmv\b/.test(command)) {
      for (const n of RULES.noDeletePaths) {
        const e = expandTilde(n);
        if (commandReferencesPath(command, n) || (e !== n && commandReferencesPath(command, e))) return { reason: `Bash command attempts to delete/move protected path: ${n}`, ask, step: `${L.bashNoDelete} · noDeletePaths` };
      }
    }
  } else if (tool === 'write' || tool === 'edit') {
    for (const p of paths) {
      const r = resolvePath(p, CWD);
      for (const ro of RULES.readOnlyPaths) if (isPathMatch(r, ro, CWD)) return { reason: `Modification of read-only path restricted: ${ro}`, ask, step: `${L.roPath} · readOnlyPaths（isPathMatch）` };
    }
  }
  return { reason, ask, step };
}
  window.DC = { HOME, CWD, RULES, check, isPathMatch };
})();
