/**
 * Verification Test: Real-world Multi-Turn Compression & Observability Logger
 * Simulates heavy developer interactions:
 * - 50KB code dump from read_file
 * - 65KB screenshot (inlineData) on historical turn
 * - 35KB diagnostic/compiler error trace
 * - Fresh screenshot on recent turn (MUST NOT BE CUT)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runJigitPipeline } = require('../src/argon/jigit-engine');
const { getCapsule } = require('../src/argon/capsule-store');
const { getCumulativeStats, LOG_FILE } = require('../src/argon/jigit-logger');

console.log('================================================================');
console.log('🧪 VERIFYING JEWISH TOKENIZER / JIGIT REAL COMPRESSION & LOGGER');
console.log('================================================================\n');

// 1. Synthetic realistic payload assets
const bigSourceCode = `// Express Gateway Server v2.0.0\nconst express = require('express');\n` +
  'function processItem(id) {\n  console.log("Processing item: " + id);\n  return { id, status: "ok" };\n}\n'.repeat(450);

const historicalBase64Img = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAYAAAA+VemSAAA' +
  'ABCDEF0123456789+='.repeat(3500); // ~66,500 chars

const heavyCompilerTrace = `FAIL tests/unit/gateway.spec.js\n` +
  `Traceback (most recent call last):\n` +
  `  File "app/main.py", line 142, in handle_connection\n` +
  `    raise ConnectionResetError("Connection lost to upstream Envoy proxy")\n` +
  `AssertionError: Expected 200 OK but received 502 Bad Gateway\n` +
  `  at Module._compile (node:internal/modules/cjs/loader:1376:14)\n` +
  `  at Object..js (node:internal/modules/cjs/loader:1435:10)\n`.repeat(250); // ~35,000 chars

const recentBase64Img = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABGCAYAAADg' + 'XYZ12345'.repeat(2500); // ~20,000 chars

const conversationId = 'verify-session-' + Date.now();

// 2. Build 10-turn conversation
const turns = [
  // Turn 0: User initial intent (MUST be preserved)
  {
    role: 'user',
    parts: [{ text: 'Please inspect the express server code and fix connection hang ups.' }]
  },
  // Turn 1: Model tool call
  {
    role: 'model',
    parts: [{
      functionCall: { name: 'read_file', args: { Path: 'src/server.js' } }
    }]
  },
  // Turn 2: Historical Tool Response (50KB code)
  {
    role: 'user',
    parts: [{
      functionResponse: {
        name: 'read_file',
        response: { output: bigSourceCode }
      }
    }]
  },
  // Turn 3: Model reply
  {
    role: 'model',
    parts: [{ text: 'I see the server code. Could you provide a screenshot of the error modal?' }]
  },
  // Turn 4: User Historical Image (66KB base64)
  {
    role: 'user',
    parts: [
      { text: 'Here is the screenshot of the crash dialog.' },
      { inlineData: { mimeType: 'image/png', data: historicalBase64Img } }
    ]
  },
  // Turn 5: Model analysis
  {
    role: 'model',
    parts: [{ text: 'Received screenshot. Running unit tests to reproduce the error.' }]
  },
  // Turn 6: Model tool call
  {
    role: 'model',
    parts: [{
      functionCall: { name: 'run_command', args: { CommandLine: 'npm test' } }
    }]
  },
  // Turn 7: Historical Diagnostic / Error Log (35KB trace)
  {
    role: 'user',
    parts: [{
      functionResponse: {
        name: 'run_command',
        response: { output: heavyCompilerTrace }
      }
    }]
  },
  // Turn 8: Model plan
  {
    role: 'model',
    parts: [{ text: 'The tests failed with a 502 socket reset. I have prepared a patch.' }]
  },
  // Turn 9: Recent user turn with fresh image (MUST REMAIN INTACT)
  {
    role: 'user',
    parts: [
      { text: 'Check this new fresh inspector screenshot.' },
      { inlineData: { mimeType: 'image/jpeg', data: recentBase64Img } }
    ]
  }
];

const originalJsonLength = JSON.stringify(turns).length;
console.log(`Original Multi-Turn Context Size: ${originalJsonLength.toLocaleString()} characters (~${Math.round(originalJsonLength / 4).toLocaleString()} tokens)\n`);

// 3. Run Jewish Tokenizer / JIGIT Pipeline
const optimized = runJigitPipeline(turns, {
  conversationId,
  keepRecentTurns: 3, // Turns 7, 8, 9 are recent; turns 0..6 are historical
});

const optimizedJsonLength = JSON.stringify(optimized).length;
const savedChars = originalJsonLength - optimizedJsonLength;
const savingsPct = ((savedChars / originalJsonLength) * 100).toFixed(1);

console.log(`Optimized Context Size:          ${optimizedJsonLength.toLocaleString()} characters (~${Math.round(optimizedJsonLength / 4).toLocaleString()} tokens)`);
console.log(`Total Characters Stripped:       ${savedChars.toLocaleString()} characters`);
console.log(`Total Token Reduction:           ~${Math.round(savedChars / 4).toLocaleString()} tokens (${savingsPct}% saved)\n`);

// 4. Assertions & Validation
console.log('--- Checking Verification Assertions ---');

// Assertion 1: Total reduction must exceed 80%
assert.ok(
  parseFloat(savingsPct) >= 80.0,
  `Expected token savings >= 80%, got ${savingsPct}%`
);
console.log(`[PASS] Token savings target met: ${savingsPct}% reduction (exceeds 80% threshold)`);

// Assertion 2: Turn 0 (Initial user intent) is preserved
assert.strictEqual(
  optimized[0].parts[0].text,
  'Please inspect the express server code and fix connection hang ups.',
  'Initial user prompt must remain pristine'
);
console.log('[PASS] Turn 0 initial intent preserved');

// Assertion 3: Historical code dump (Turn 2) was compacted to capsule
const t2Output = optimized[2].parts[0].functionResponse.response.output;
assert.ok(t2Output.includes('[JIGIT Engine: Compacted File: read_file'), 'Turn 2 must be compacted');
const t2CapMatch = t2Output.match(/capsule=([a-zA-Z0-9_-]+)/);
assert.ok(t2CapMatch, 'Turn 2 must contain a capsule ID');
const storedCode = getCapsule(t2CapMatch[1], { conversationId });
assert.ok(storedCode && storedCode.content === bigSourceCode, 'Compacted code must be retrievable from capsule store');
console.log(`[PASS] Turn 2 code dump compacted (capsule: ${t2CapMatch[1]}) and verified in capsule store`);

// Assertion 4: Historical image (Turn 4) was offloaded to capsule
assert.strictEqual(
  optimized[4].parts[1].inlineData,
  undefined,
  'Turn 4 inlineData must be stripped from payload'
);
assert.ok(
  optimized[4].parts[1].text.includes('[JIGIT Engine: Historical image (image/png'),
  'Turn 4 must contain placeholder with capsule reference'
);
const imgCapMatch = optimized[4].parts[1].text.match(/capsule (jigit-img-[a-zA-Z0-9]+)/);
assert.ok(imgCapMatch, 'Turn 4 placeholder must reference jigit-img capsule');
const storedImg = getCapsule(imgCapMatch[1], { conversationId });
assert.ok(storedImg && storedImg.content === historicalBase64Img, 'Historical image base64 must match original in capsule store');
console.log(`[PASS] Turn 4 historical image archived (capsule: ${imgCapMatch[1]}) and verified in capsule store`);

// Assertion 5: Recent image (Turn 9) MUST NOT be stripped
assert.ok(
  optimized[9].parts[1].inlineData,
  'Turn 9 (recent turn) inlineData must be preserved for Gemini Vision'
);
assert.strictEqual(
  optimized[9].parts[1].inlineData.data,
  recentBase64Img,
  'Turn 9 inlineData base64 must remain completely intact'
);
console.log('[PASS] Turn 9 fresh image preserved 100% untouched for vision processing');

// Assertion 6: Cumulative stats and log file
const stats = getCumulativeStats();
console.log('\n--- Logger Cumulative Statistics ---');
console.log(`Total Requests Tracked:  ${stats.totalRuns}`);
console.log(`Total Items Compacted:   ${stats.totalItemsCompacted}`);
console.log(`Total Characters Saved:  ${stats.totalSavedChars.toLocaleString()}`);
console.log(`Total Tokens Saved:      ~${stats.totalSavedTokens.toLocaleString()}`);
console.log(`Overall Reduction:       ${stats.overallReductionPct}`);
console.log(`Log File Destination:    ${stats.logFilePath}`);

assert.ok(stats.totalRuns >= 1, 'Tracker must register completed runs');
assert.ok(stats.totalSavedChars > 0, 'Tracker must record saved characters');

if (fs.existsSync(stats.logFilePath)) {
  const logContent = fs.readFileSync(stats.logFilePath, 'utf8');
  assert.ok(logContent.includes(conversationId), 'Log file must contain entry for current conversation');
  console.log('[PASS] Log file successfully written and verified on disk');
}

console.log('\n================================================================');
console.log('✅ ALL ENGINE VERIFICATION AND LOGGER TESTS PASSED SUCCESSFULLY!');
console.log('================================================================\n');
