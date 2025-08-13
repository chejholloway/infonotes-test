#!/usr/bin/env node
/* eslint no-console: 0 */
/**
 * Class-free version with:
 * - fetch API (Node 18+)
 * - jsdom for HTML parsing (lazy import)
 * - Structured error helpers using Error options { cause }
 * - Clean functional decomposition and robust validation
 *
 * Usage:
 *   node renderGrid.js https://example.com/page
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ----- Error helpers (no classes) -----
const withName = (err, name) => {
  if (err && typeof err === 'object') err.name = name;
  return err;
};

const httpError = (message, { status = null, url = null, cause = null } = {}) => {
  const e = new Error(message, { cause });
  e.status = status;
  e.url = url;
  return withName(e, 'HttpError');
};

const parseError = (message, { cause = null } = {}) => withName(new Error(message, { cause }), 'ParseError');

const dataError = (message, { cause = null } = {}) => withName(new Error(message, { cause }), 'DataError');

// ----- Lazy dependency load -----
const loadJsdom = async () => {
  try {
    const { JSDOM } = await import('jsdom');
    return JSDOM;
  } catch (cause) {
    throw dataError("Missing dependency 'jsdom'. Install with: npm i jsdom", { cause });
  }
};

// ----- Fetch or read HTML -----
const getHtml = async (source) => {
  if (!source || typeof source !== 'string') {
    throw dataError('A URL or file path string is required');
  }
  const isHttp = /^https?:\/\//i.test(source);
  const isFileUrl = /^file:\/\//i.test(source);

  if (isHttp) {
    let res;
    try {
      res = await fetch(source, { redirect: 'follow' });
    } catch (cause) {
      throw httpError(`Network error requesting ${source}`, { url: source, cause });
    }
    if (!res.ok) {
      // Provide both status and statusText when available
      const msg = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for ${source}`;
      throw httpError(msg, { status: res.status, url: source });
    }
    try {
      return await res.text();
    } catch (cause) {
      throw httpError(`Failed reading response body from ${source}`, { url: source, cause });
    }
  }

  // Local file support: path or file://
  const fileUrl = isFileUrl ? source : pathToFileURL(source).href;
  try {
    const buf = await readFile(fileURLToPath(fileUrl));
    return buf.toString('utf8');
  } catch (cause) {
    throw httpError(`Failed reading local file ${fileUrl}`, { url: fileUrl, cause });
  }
};

// ----- Parse and select rows -----
const getTableRows = async (html) => {
  const JSDOM = await loadJsdom();
  try {
    const { window } = new JSDOM(html);
    const { document } = window;
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.slice(1); // mirror Python: skip header row
  } catch (cause) {
    throw parseError('Failed to parse HTML and select <tr> elements', { cause });
  }
};

// ----- Extract coordinates and chars -----
const extractDataFromRows = (rows) => {
  const digitRe = /\d+/g;
  const nonDigitRe = /\D+/g;

  const coords = [];
  const chars = [];

  for (const row of rows) {
    const text = row?.textContent ?? '';
    const digits = Array.from(text.matchAll(digitRe)).map(m => m[0]);
    const nonDigits = Array.from(text.matchAll(nonDigitRe)).map(m => m.trim()).filter(Boolean);

    if (digits.length < 2) {
      throw dataError(`Row missing at least two coordinates: "${text}"`);
    }
    const [xStr, yStr] = digits;
    const x = Number.parseInt(xStr, 10);
    const y = Number.parseInt(yStr, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw dataError(`Invalid numeric coordinates in row: "${text}"`);
    }

    const char = nonDigits.length ? nonDigits : ' ';
    coords.push([x, y]);
    chars.push(char);
  }

  return { coords, chars };
};

// ----- Build and render grid -----
const buildAndRenderGrid = (coords, chars) => {
  if (coords.length !== chars.length) {
    throw dataError('Coordinates and characters length mismatch');
  }
  if (coords.length === 0) {
    console.log('');
    return;
  }

  const maxX = Math.max(...coords.map(([x]) => x)) + 1;
  const maxY = Math.max(...coords.map(([, y]) => y)) + 1;

  if (!Number.isInteger(maxX) || !Number.isInteger(maxY) || maxX <= 0 || maxY <= 0) {
    throw dataError(`Invalid grid size computed: ${maxX}x${maxY}`);
  }

  const grid = Array.from({ length: maxY }, () => Array.from({ length: maxX }, () => ' '));

  for (let i = 0; i < coords.length; i += 1) {
    const [x, y] = coords[i];
    const ch = chars[i];

    if (x < 0 || y < 0 || y >= grid.length || x >= grid[0].length) {
      // Out-of-bounds coordinates are ignored safely
      continue;
    }
    const printable = String(ch);
    grid[y][x] = printable.length > 0 ? printable : ' ';
  }

  for (let row = grid.length - 1; row >= 0; row -= 1) {
    console.log(grid[row].join(''));
  }
};

// ----- Public entry point -----
export const renderFromUrl = async (urlOrPath) => {
  const html = await getHtml(urlOrPath);
  const rows = await getTableRows(html);
  const { coords, chars } = extractDataFromRows(rows);
  buildAndRenderGrid(coords, chars);
};

// ----- CLI wrapper -----
if (import.meta.url === pathToFileURL(process.argv[21]).href) {
  (async () => {
    try {
      const url = process.argv[22];
      if (!url) {
        console.error('Usage: node renderGrid.js <url-or-filepath>');
        process.exitCode = 1;
        return;
      }
      await renderFromUrl(url);
    } catch (err) {
      // Centralized, readable diagnostics (no classes; rely on tags and properties)
      const lines = [
        `[${err?.name ?? 'Error'}] ${err?.message ?? 'Unknown error'}`,
      ];
      if (err?.status) lines.push(`Status: ${err.status}`);
      if (err?.url) lines.push(`Resource: ${err.url}`);
      if (err?.cause) lines.push(`Cause: ${err.cause?.message ?? String(err.cause)}`);
      console.error(lines.join('\n'));
      process.exitCode = 1;
    }
  })();
}
