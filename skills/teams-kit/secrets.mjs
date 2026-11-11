// Outgoing-text filter: refuse anything that quotes the kit's .env or looks like a credential.
// Returns the names of what matched, never the values.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const SENSITIVE_KEY = /(CLIENT_ID|TENANT_ID|_OID|SECRET|TOKEN|PASSWORD|PASSWD|KEY)$/;
const PATTERNS = [
  ['jwt', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/],
  ['refresh-token', /\b[01]\.A[\w-]{60,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['api-key', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/],
  ['env-line', /^\s*(?:export\s+)?(?:BEING|OWNER|M365)_[A-Z0-9_]+=/m],
  // Cloudflare: tunnel connector token (base64 JSON), Access service-token id/secret, API token assignments, cert.pem.
  ['cloudflare-token', /\beyJhIjoi[A-Za-z0-9+/_=-]{40,}|\b[0-9a-f]{32}\.access\b|-----BEGIN ARGO TUNNEL TOKEN-----|\b(?:TUNNEL_SERVICE_TOKEN_(?:ID|SECRET)|CF[_-]Access[_-]Client[_-](?:Id|Secret)|CF_API_TOKEN|TUNNEL_TOKEN)\s*[:=]\s*\S{8,}/i],
  ['credential-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S{6,}/i],
];
// Cloudflare API tokens: a lone run of 40 url-safe characters mixing cases and digits, outside links (share ids).
const CF_API = /(?<![\w-])(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=[\w-]*\d)[\w-]{40}(?![\w-])/;
const LINKS = /\b(?:https?:\/\/|www\.)[^\s"'<>]+|\bhref=["'][^"']*["']/gi;
// Tunnel connector tokens: base64 JSON carrying the a (account), t (tunnel) and s (secret) keys.
const B64_JSON = /(?<![\w+/-])eyJ[A-Za-z0-9+/_-]{30,}={0,2}/g;
export function cloudflareTunnelToken(text) {
  for (const m of String(text || '').matchAll(B64_JSON)) {
    try {
      const j = JSON.parse(Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (j && typeof j === 'object' && 'a' in j && 't' in j && 's' in j) return true;
    } catch {}
  }
  return false;
}

// One-time codes (123456, 123 456, 123-456) masked before text reaches a log.
export const redactCodes = (s) => String(s ?? '').replace(/(?<![\w.:/-])\d{3}[ -]?\d{3}(?![\w-]|[.:/]\d)/g, '[code]');

// .env values worth protecting: tenant/app/object ids and anything named like a secret. Names, UPNs, paths pass.
export function envSecrets(file = path.join(KIT, '.env'), env = process.env) {
  const out = [];
  const add = (k, v) => { v = (v || '').trim(); if (SENSITIVE_KEY.test(k) && v.length >= 8) out.push([k, v]); };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (/^'.*'$|^".*"$/.test(v.split(/\s+#/)[0].trim())) v = v.split(/\s+#/)[0].trim().slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      add(m[1], v);
    }
  }
  for (const [k, v] of Object.entries(env)) if (/^(BEING|OWNER|M365)_/.test(k)) add(k, v);
  return out;
}

// Attachment bytes get the same scan (latin1 keeps every ASCII credential intact). Returns "<file>: <match>" names.
export function findSecretsInFiles(files, { secrets = envSecrets() } = {}) {
  return files.flatMap((f) => findSecrets(readFileSync(f).toString('latin1'), { secrets }).map((n) => `${path.basename(f)}: ${n}`));
}

export function findSecrets(text, { secrets = envSecrets() } = {}) {
  const t = String(text || '');
  const plain = t.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
  const hits = [];
  for (const [k, v] of secrets) if (t.includes(v) || plain.includes(v)) hits.push(k);
  for (const [name, re] of PATTERNS) if (re.test(t) || re.test(plain)) hits.push(name);
  if (cloudflareTunnelToken(t) || cloudflareTunnelToken(plain)) hits.push('cloudflare-tunnel-token');
  if (CF_API.test(t.replace(LINKS, ' ')) || CF_API.test(plain.replace(LINKS, ' '))) hits.push('cloudflare-api-token');
  return [...new Set(hits)];
}
