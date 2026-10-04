/*
 * Adapted from github.com/fengshao1227/ccg-workflow templates/skills/tools/lib/shared.js (MIT).
 *
 * MIT License
 *
 * Copyright (c) 2025 fengshao1227
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';

/**
 * Shared helpers for the verify-* scripts.
 */

// --- CLI argument parsing ---

function parseCliArgs(argv, extraFlags) {
  const args = argv.slice(2);
  const result = { target: '.', verbose: false, json: false };
  if (extraFlags) Object.assign(result, extraFlags);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-v' || args[i] === '--verbose') result.verbose = true;
    else if (args[i] === '--json') result.json = true;
    else if (args[i] === '-h' || args[i] === '--help') { result.help = true; }
    else if (args[i] === '--mode' && args[i + 1]) { result.mode = args[++i]; }
    else if (args[i] === '--exclude') {
      result.exclude = result.exclude || [];
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) result.exclude.push(args[++i]);
    }
    else if (!args[i].startsWith('-')) result.target = args[i];
  }
  return result;
}

// --- Report formatting ---

const SEP = '='.repeat(60);
const DASH = '-'.repeat(40);
const ICONS = {
  error: '\u2717', warning: '\u26A0', info: '\u2139',
  critical: '\u{1F534}', high: '\u{1F7E0}', medium: '\u{1F7E1}', low: '\u{1F535}'
};

function reportHeader(title, fields) {
  const lines = [SEP, title, SEP];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`\n${k}: ${v}`);
  }
  return lines;
}

function reportIssues(issues, verbose, groupBy) {
  if (!issues.length) return [];
  const lines = ['\n' + DASH, 'Issues:', DASH];

  if (groupBy) {
    const groups = {};
    for (const i of issues) (groups[i[groupBy]] || (groups[i[groupBy]] = [])).push(i);
    for (const cat of Object.keys(groups).sort()) {
      const items = groups[cat];
      lines.push(`\n[${cat}] (${items.length})`);
      for (const i of items.slice(0, 10)) {
        lines.push(`  ${ICONS[i.severity] || '\u2139'} ` +
          `${i.file_path || ''}${i.line_number ? ':' + i.line_number : ''}`);
        lines.push(`    ${i.message}`);
        if (verbose && i.suggestion) lines.push(`    \u{1F4A1} ${i.suggestion}`);
        if (verbose && i.recommendation) lines.push(`    \u{1F4A1} ${i.recommendation}`);
      }
      if (items.length > 10) lines.push(`  ... and ${items.length - 10} more issues`);
    }
  } else {
    for (const i of issues) {
      const icon = ICONS[i.severity] || '\u2139';
      lines.push(`  ${icon} [${i.severity.toUpperCase()}] ${i.message}`);
      if (i.path && verbose) lines.push(`    Path: ${i.path}`);
    }
  }
  return lines;
}

function reportFooter() { return ['\n' + SEP]; }

function buildReport(title, fields, issues, verbose, groupBy) {
  return [...reportHeader(title, fields), ...reportIssues(issues, verbose, groupBy), ...reportFooter()].join('\n');
}

// --- Counting ---

function countBySeverity(issues, field) {
  field = field || 'severity';
  const counts = {};
  for (const i of issues) counts[i[field]] = (counts[i[field]] || 0) + 1;
  return counts;
}

function hasFatal(issues, fatalLevels) {
  fatalLevels = fatalLevels || ['error'];
  return issues.some(i => fatalLevels.includes(i.severity));
}

module.exports = {
  parseCliArgs, buildReport, reportHeader, reportIssues,
  reportFooter, countBySeverity, hasFatal, SEP, DASH, ICONS
};
