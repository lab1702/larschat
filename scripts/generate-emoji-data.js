#!/usr/bin/env node
'use strict';

// Fetches the official Unicode emoji-test.txt and generates a JS data file
// for the emoji picker. Excludes skin tone variants to keep the picker manageable.

const https = require('https');
const fs = require('fs');
const path = require('path');

const EMOJI_TEST_URL = 'https://unicode.org/Public/emoji/latest/emoji-test.txt';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Skin tone modifier code points
const SKIN_TONES = new Set([
  '1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'
]);

function hasSkinTone(codepoints) {
  return codepoints.split(' ').some(cp => SKIN_TONES.has(cp));
}

async function main() {
  console.log('Fetching emoji-test.txt...');
  const text = await fetch(EMOJI_TEST_URL);
  const lines = text.split('\n');

  const groups = {};
  let currentGroup = null;

  for (const line of lines) {
    // Group header
    const groupMatch = line.match(/^# group: (.+)/);
    if (groupMatch) {
      currentGroup = groupMatch[1];
      if (!groups[currentGroup]) groups[currentGroup] = [];
      continue;
    }

    // Skip comments and blank lines
    if (!line.trim() || line.startsWith('#')) continue;

    // Parse emoji line: "1F600  ; fully-qualified  # 😀 E1.0 grinning face"
    const match = line.match(/^([0-9A-F ]+)\s+;\s+(fully-qualified|component)\s+#\s+(\S+)/);
    if (!match) continue;

    const [, codepoints, status, emoji] = match;
    if (status !== 'fully-qualified') continue;
    if (!currentGroup) continue;

    // Skip skin tone variants
    if (hasSkinTone(codepoints.trim())) continue;

    groups[currentGroup].push(emoji);
  }

  // Remove "Component" group (skin tone swatches, hair pieces, etc.)
  delete groups['Component'];

  const outPath = path.join(__dirname, '..', 'public', 'emoji-data.js');
  const js = `// Auto-generated from Unicode emoji-test.txt — do not edit manually\n// Run: node scripts/generate-emoji-data.js\nvar EMOJI_DATA = ${JSON.stringify(groups, null, 2)};\n`;

  fs.writeFileSync(outPath, js);
  const totalCount = Object.values(groups).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Wrote ${outPath}`);
  console.log(`${Object.keys(groups).length} groups, ${totalCount} emojis total`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
