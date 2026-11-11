#!/usr/bin/env node
// Write {sheet: [[cell, ...], ...]} into an Excel workbook on the Being's OneDrive through the Excel API (works while
// people have it open). Rows past the new data are cleared; cells are written as text. Owner lane only.
//   workbook-sync.mjs <remotePath.xlsx> <sheets.json>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemPath } from './drive-util.mjs';

export const col = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Rectangular string grid plus the range it fills, e.g. A1:C4.
export function grid(rows) {
  if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new Error('each sheet needs a non-empty array of rows');
  const width = Math.max(1, ...rows.map((r) => r.length));
  const values = rows.map((r) => [...r, ...Array(width - r.length).fill('')].map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))));
  return { values, width, address: `A1:${col(width)}${rows.length}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { connect, fail, standby, beingSender } = await import('./graph.mjs');
  const { currentScope } = await import('./scope.mjs');
  const { findSecrets } = await import('./secrets.mjs');
  const [remote, json] = process.argv.slice(2);
  if (!remote || !json) fail('usage: workbook-sync.mjs <remotePath.xlsx> <sheets.json {"Sheet1": [[...], ...]}>', 2);
  const sheets = JSON.parse(readFileSync(json, 'utf8'));
  const leak = findSecrets(JSON.stringify(sheets));
  if (leak.length) fail(`blocked: the rows look like they contain secrets (${leak.join(', ')})`, 3);
  const SENDER = beingSender();
  if (standby()) fail('standby host: read-only', 3);
  const { scope } = currentScope();
  if (!['full', 'owner-only'].includes(scope)) fail(`blocked: workbook-sync is for the owner lane (${scope})`, 3);
  const { g } = await connect({ ...SENDER, sender: true, scopes: ['Files.ReadWrite', 'User.Read'] });
  try {
    const it = await g(itemPath(remote));
    const base = `/me/drive/items/${it.id}/workbook`;
    const h = { 'workbook-session-id': (await g(`${base}/createSession`, { body: { persistChanges: true } })).id };
    try {
      for (const [sheet, rows] of Object.entries(sheets)) {
        const { values, width, address } = grid(rows);
        const ws = `${base}/worksheets('${encodeURIComponent(sheet.replace(/'/g, "''"))}')`;
        const used = await g(`${ws}/usedRange(valuesOnly=true)?$select=rowCount,columnCount`, { headers: h });
        if (used.rowCount > rows.length) {
          await g(`${ws}/range(address='A${rows.length + 1}:${col(Math.max(width, used.columnCount))}${used.rowCount}')/clear`, { headers: h, body: { applyTo: 'Contents' } });
        }
        await g(`${ws}/range(address='${address}')`, { method: 'PATCH', headers: h, body: { numberFormat: values.map((r) => r.map(() => '@')), values } });
        console.log(`${sheet}: wrote ${address}`);
      }
    } finally { await g(`${base}/closeSession`, { headers: h, body: {} }).catch(() => {}); }
  } catch (e) { fail(`workbook-sync: ${e.message}`); }
}
