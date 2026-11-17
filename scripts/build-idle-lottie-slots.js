/**
 * Fills the idle screen's Lottie slots and posters.
 *
 *   node scripts/build-idle-lottie-slots.js          # create missing files only
 *   node scripts/build-idle-lottie-slots.js --force  # overwrite every slot
 *
 * Existing slot files are kept by default so a custom or downloaded
 * animation dropped into a slot is never overwritten.
 */
const fs = require('node:fs');
const path = require('node:path');
const { packDotLottie } = require('./lib/dotlottie-zip');

const LOTTIE_DIR = path.resolve(__dirname, '..', 'src', 'public', 'assets', 'lottie');
const SLOT_DIR = path.join(LOTTIE_DIR, 'idle');
const POSTER_DIR = path.join(SLOT_DIR, 'posters');
const force = process.argv.includes('--force');

// [slot name, source file in assets/lottie, display name]
// idle-src/*.json come from scripts/generate-idle-lottie-assets.js.
const SLOTS = [
  ['welcome', 'idle-src/welcome.json', 'PrintBit — Welcome'],
  ['how-to-print', 'upload.lottie', 'PrintBit — How to print'],
  ['how-to-copy', 'copy-glass.lottie', 'PrintBit — How to copy'],
  ['id-card-copy', 'copy-adf.lottie', 'PrintBit — ID card copy'],
  ['scan-to-phone', 'scan-transfer.lottie', 'PrintBit — Scan to phone'],
  ['prices', 'coin-insertion.json', 'PrintBit — Prices'],
  ['paying', 'idle-src/paying.json', 'PrintBit — Accepted coins'],
  ['supported-files', 'idle-src/supported-files.json', 'PrintBit — Supported files'],
  ['privacy-receipt', 'idle-src/privacy-receipt.json', 'PrintBit — Privacy'],
];

const icon = (inner) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" aria-hidden="true">' +
  '<rect width="240" height="240" rx="48" fill="#696fc7" fill-opacity="0.16"/>' +
  '<g fill="none" stroke="#a7aae1" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">' +
  inner +
  '</g></svg>\n';

const POSTERS = {
  welcome: icon(
    '<path d="M80 95V55h80v40"/><rect x="55" y="95" width="130" height="65" rx="12"/><rect x="80" y="140" width="80" height="50" rx="4"/>',
  ),
  'how-to-print': icon(
    '<rect x="85" y="45" width="70" height="150" rx="14"/><path d="M110 170h20"/>',
  ),
  'how-to-copy': icon(
    '<rect x="60" y="60" width="90" height="115" rx="8"/><rect x="90" y="85" width="90" height="115" rx="8"/>',
  ),
  'id-card-copy': icon(
    '<rect x="45" y="75" width="150" height="95" rx="12"/><circle cx="90" cy="115" r="16"/><path d="M125 105h45M125 130h35M75 150h40"/>',
  ),
  'scan-to-phone': icon(
    '<rect x="40" y="60" width="90" height="120" rx="8"/><path d="M30 120h110"/><rect x="150" y="80" width="55" height="100" rx="10"/>',
  ),
  prices: icon('<path d="M95 60v120M95 60h35a30 30 0 0 1 0 60H95M80 90h80M80 105h80"/>'),
  paying: icon(
    '<circle cx="52" cy="128" r="21"/><circle cx="102" cy="128" r="23"/><circle cx="156" cy="128" r="25"/><circle cx="198" cy="128" r="14"/><path d="M90 70h60"/>',
  ),
  'supported-files': icon(
    '<path d="M75 45h65l35 35v115H75z"/><path d="M140 45v35h35M95 120h60M95 145h60"/>',
  ),
  'privacy-receipt': icon(
    '<path d="M120 45l60 22v48c0 40-26 68-60 80-34-12-60-40-60-80V67z"/><path d="M95 120l18 18 35-38"/>',
  ),
};

const shouldWrite = (target) => force || !fs.existsSync(target);

fs.mkdirSync(POSTER_DIR, { recursive: true });

for (const [slot, source, displayName] of SLOTS) {
  const target = path.join(SLOT_DIR, `${slot}.lottie`);
  if (!shouldWrite(target)) {
    console.log(`keep   idle/${slot}.lottie (exists; --force to overwrite)`);
  } else {
    const sourcePath = path.join(LOTTIE_DIR, source);
    if (source.endsWith('.json')) {
      const json = fs.readFileSync(sourcePath, 'utf8');
      JSON.parse(json); // fail fast on a broken source
      fs.writeFileSync(target, packDotLottie(slot, displayName, json));
    } else {
      fs.copyFileSync(sourcePath, target);
    }
    console.log(`write  idle/${slot}.lottie <- ${source}`);
  }

  const posterTarget = path.join(POSTER_DIR, `${slot}.svg`);
  if (shouldWrite(posterTarget)) {
    fs.writeFileSync(posterTarget, POSTERS[slot], 'utf8');
    console.log(`write  idle/posters/${slot}.svg`);
  }
}
