import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Lazy-load jsdom only when needed to keep startup cost minimal.
async function loadJsdom() {
  try {
    const { JSDOM } = await import('jsdom');
    return JSDOM;
  } catch (err) {
    throw new Error(
      "Missing dependency: 'jsdom'. Install with: npm i jsdom",
      { cause: err }
    );
  }
}

class HttpError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? null;
    this.url = url ?? null;
    if (cause) this.cause = cause;
  }
}

class ParseError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ParseError';
    if (cause) this.cause = cause;
  }
}

class DataError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'DataError';
    if (cause) this.cause = cause;
  }
}

/**
 * Fetch HTML text from a URL or file path.
 * Supports:
 *  - http(s) URLs
 *  - local file path (prefixed with file:// or plain path)
 */
async function getHtml(source) {
  const isHttp = /^https?:\/\//i.test(source);
  const isFileUrl = /^file:\/\//i.test(source);

  if (isHttp) {
    let res;
    try {
      res = await fetch(source, {
        // Keep it simple; add headers/UA if a site requires it
        redirect: 'follow',
      });
    } catch (cause) {
      throw new HttpError(`Network error requesting ${source}`, { url: source, cause });
    }
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status} for ${source}`, { status: res.status, url: source });
    }
    try {
      return await res.text();
    } catch (cause) {
      throw new HttpError(`Failed reading response body from ${source}`, { url: source, cause });
    }
  }

  // Support local files, useful for testing
  const fileUrl = isFileUrl ? source : pathToFileURL(source).href;
  try {
    const buf = await readFile(fileURLToPath(fileUrl));
    return buf.toString('utf8');
  } catch (cause) {
    throw new HttpError(`Failed reading local file ${fileUrl}`, { url: fileUrl, cause });
  }
}

/**
 * Parse HTML and return all <tr> elements (excluding the header row).
 */
async function getTableRows(html) {
  const JSDOM = await loadJsdom();
  try {
    const { window } = new JSDOM(html);
    const { document } = window;
    const rows = Array.from(document.querySelectorAll('tr'));
    // Mirror Python logic: skip the first row
    return rows.slice(1);
  } catch (cause) {
    throw new ParseError('Failed to parse HTML and select <tr> elements', { cause });
  }
}

/**
 * Extract coordinates (x, y) and character string from each row’s text content.
 * - Coordinates: all digit sequences -> expect at least two per row
 * - Character: the first non-digit sequence trimmed
 */
function extractDataFromRows(rows) {
  const digitRe = /\d+/g;
  const nonDigitRe = /\D+/g;

  const coords = [];
  const chars = [];

  for (const row of rows) {
    const text = row.textContent ?? '';
    const digits = Array.from(text.matchAll(digitRe)).map(m => m[0]);
    const nonDigits = Array.from(text.matchAll(nonDigitRe)).map(m => m.trim()).filter(Boolean);

    if (digits.length < 2) {
      throw new DataError(`Row missing at least two coordinates: "${text}"`);
    }

    // Take first two numbers as [x, y]
    const [xStr, yStr] = digits;
    const x = Number.parseInt(xStr, 10);
    const y = Number.parseInt(yStr, 10);

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DataError(`Invalid numeric coordinates in row: "${text}"`);
    }

    // Mimic original: the first non-digit sequence as the character string
    const char = nonDigits.length ? nonDigits : ' ';
    // If char is multiple characters, keep as-is to mirror Python behavior
    coords.push([x, y]);
    chars.push(char);
  }

  return { coords, chars };
}

/**
 * Build the grid, place characters at their (x, y), then print with inverted Y so (0,0) is bottom-left.
 */
function buildAndRenderGrid(coords, chars) {
  if (coords.length !== chars.length) {
    throw new DataError('Coordinates and characters length mismatch');
  }
  if (coords.length === 0) {
    console.log(''); // nothing to render
    return;
  }

  const maxX = Math.max(...coords.map(([x]) => x)) + 1;
  const maxY = Math.max(...coords.map(([, y]) => y)) + 1;

  if (!Number.isInteger(maxX) || !Number.isInteger(maxY) || maxX <= 0 || maxY <= 0) {
    throw new DataError(`Invalid grid size computed: ${maxX}x${maxY}`);
  }

  // Create grid filled with single spaces
  const grid = Array.from({ length: maxY }, () => Array.from({ length: maxX }, () => ' '));

  // Place each character onto its coordinate
  for (let i = 0; i < coords.length; i += 1) {
    const [x, y] = coords[i];
    const ch = chars[i];

    if (x < 0 || y < 0 || y >= grid.length || x >= grid[0].length) {
      // Skip out-of-bounds gracefully
      // Could also choose to expand grid dynamically if desired
      continue;
    }

    // If char is longer than one character, place the first character only to keep grid monospace,
    // or place full string; here we place the first visible character for neatness.
    const printable = String(ch);
    grid[y][x] = printable.length > 0 ? printable : ' ';
  }

  // Print inverted Y so (0,0) appears bottom-left
  for (let row = grid.length - 1; row >= 0; row -= 1) {
    console.log(grid[row].join(''));
  }
}

/**
 * Main entry: fetch, parse, extract, render.
 */
export async function renderFromUrl(urlOrPath) {
  if (!urlOrPath || typeof urlOrPath !== 'string') {
    throw new TypeError('A URL or file path string is required');
  }

  const html = await getHtml(urlOrPath);
  const rows = await getTableRows(html);
  const { coords, chars } = extractDataFromRows(rows);
  buildAndRenderGrid(coords, chars);
}

// CLI support
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      const url = process.argv[2];
      if (!url) {
        console.error('Usage: node renderGrid.js <url-or-filepath>');
        process.exitCode = 1;
        return;
      }
      await renderFromUrl(url);
    } catch (err) {
      // Centralized error reporting with readable details
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
