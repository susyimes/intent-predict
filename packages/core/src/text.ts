// Patterns, redaction and text helpers (SPEC 2.2, 4.7, 5.4, 7.1).
// "Characters" are Unicode code points throughout; only the fork prompt budget is in UTF-8 bytes.

/** Pattern sources exactly as printed in SPEC.md (a test checks they occur there verbatim). */
export const PATTERNS = {
  check: String.raw`(?:^|[\s;&|(/])(?:pytest|py\.test|unittest|tox|nox|jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|node\s+--test|deno\s+(?:test|check|lint)|go\s+(?:test|vet|build)|cargo\s+(?:test|check|clippy|build)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|tsc|eslint|ruff|mypy|pyright|flake8|make\s+(?:test|check|build|lint)|(?:\./)?gradlew?\s+(?:test|build|check)|mvn\s+(?:test|verify|package|compile)|dotnet\s+(?:test|build)|ctest|phpunit|rspec|rake\s+test|swift\s+(?:test|build)|bazel\s+(?:test|build))\b`,
  question: String.raw`(?:吗|呢|好吗|可以吗|对吗|是吗|如何|怎样|哪一个|哪个)\s*[。！!.]?$`,
  numbered: String.raw`^\s*(?:(\d{1,2})[.)、]|[(（](\d{1,2})[)）])\s+(.+)$`,
  recommended: String.raw`[(（]\s*(?:recommended|推荐)\s*[)）]`,
  slash: String.raw`(?:^|[\`"'“「『])(/[a-z][a-z0-9_-]{1,30})(?=$|[\`"'”」』\s])`,
  literal: String.raw`(?:type|run|enter|reply with|输入|发送|回复)\s*["'“「『]([^"'”」』\n]{1,40})["'”」』]`,
  destructive: String.raw`(?:\brm\s+-[a-z]*[rf][a-z]*\b|\bgit\s+push\b[^\n]*\s(?:--force\S*|-f)\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*[fd]|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\bdelete\s+from\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bformat\s+[a-z]:|\bchmod\s+(?:-R\s+)?777\b|\bcurl\b[^\n]*\|\s*(?:sh|bash)\b|删库|强制推送|清空数据|不可恢复|永久删除)`,
  external: String.raw`(?:\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|\b(?:npm|cargo)\s+publish\b|\bdeploy\b|\b(?:kubectl|terraform)\s+apply\b|\bdocker\s+push\b|推送到远端|推到生产|发布到|部署到|合并\s*PR|发送邮件)`,
} as const;
// String.raw keeps the backslash before a backtick, which the template literal needs; drop it again.
const src = (pattern: string) => pattern.replaceAll('\\`', '`');
export const PATTERN_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(PATTERNS).map(([name, pattern]) => [name, src(pattern)]),
);

export const CHECK_RE = new RegExp(src(PATTERNS.check), 'iu');
export const QUESTION_RE = new RegExp(src(PATTERNS.question), 'u');
export const NUMBERED_RE = new RegExp(src(PATTERNS.numbered), 'u');
export const RECOMMENDED_RE = new RegExp(src(PATTERNS.recommended), 'iu');
export const SLASH_RE = new RegExp(src(PATTERNS.slash), 'giu');
export const LITERAL_RE = new RegExp(src(PATTERNS.literal), 'giu');
export const DESTRUCTIVE_RE = new RegExp(src(PATTERNS.destructive), 'iu');
export const EXTERNAL_RE = new RegExp(src(PATTERNS.external), 'iu');
export const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
export function firstCps(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}
export function lastCps(s: string, n: number): string {
  if (s.length <= n) return s;
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(-n).join('');
}
/** Keep the first n characters and mark the cut. */
export function cut(s: string, n: number): string {
  return cpLength(s) <= n ? s : firstCps(s, n) + '…';
}
/** Keep the last n characters and mark the cut. */
export function cutStart(s: string, n: number): string {
  return cpLength(s) <= n ? s : '…' + lastCps(s, n);
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{16,}|hf_[A-Za-z0-9]{16,})/g, '[REDACTED_API_KEY]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [REDACTED_TOKEN]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/gi, '$1[REDACTED_AUTH]@'],
  [/((?:api[_-]?key|secret|token|password|access[_-]?key)\s*[:=]\s*)['"]?[A-Za-z0-9._~+/=-]{8,}['"]?/gi, '$1[REDACTED_SECRET]'],
];
const STRICT_REDACTIONS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_PII]'],
  [/(?<![0-9])\+?[0-9][0-9 -]{8,14}[0-9](?![0-9])/g, '[REDACTED_PII]'],
];

export function redact(text: string, strict = false): string {
  for (const [rx, replacement] of strict ? [...REDACTIONS, ...STRICT_REDACTIONS] : REDACTIONS) {
    text = text.replace(rx, replacement);
  }
  return text;
}

/** SPEC 5.4: wording similarity, recorded only. */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => Array.from(s.split(/\s+/u).filter(Boolean).join(' '));
  const ca = norm(a);
  const cb = norm(b);
  const sa = ca.join('');
  const sb = cb.join('');
  if (ca.length >= 2 && cb.length >= 2 && (sa.includes(sb) || sb.includes(sa))) return 1;
  const grams = (cs: string[]) => cs.slice(0, -1).map((c, i) => c + cs[i + 1]);
  const ga = grams(ca);
  const gb = grams(cb);
  if (!ga.length || !gb.length) return 0;
  const count = (gs: string[]) => {
    const m = new Map<string, number>();
    for (const g of gs) m.set(g, (m.get(g) ?? 0) + 1);
    return m;
  };
  const ma = count(ga);
  const mb = count(gb);
  let inter = 0;
  for (const [g, n] of ma) inter += Math.min(n, mb.get(g) ?? 0);
  return (2 * inter) / (ga.length + gb.length);
}

export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
