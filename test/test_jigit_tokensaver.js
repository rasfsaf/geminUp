const assert = require('assert');
const { runJigitPipeline } = require('../src/argon/jigit-engine');
const { getCapsule } = require('../src/argon/capsule-store');

console.log('=== TEST SUITE: JIGIT ENGINE TOKEN SAVER FOR NATIVE ANTIGRAVITY ===');

// 1. Test compaction of large file tool result
const bigFileContent = 'const a = 1;\n'.repeat(500); // ~6500 chars
const mockTurns = [
  {
    role: 'user',
    parts: [{ text: 'Please read the main file.' }],
  },
  {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { Path: 'src/main.js' },
        },
      },
    ],
  },
  {
    role: 'model',
    parts: [
      {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: {
            output: bigFileContent,
          },
        },
      },
    ],
  },
];

console.log('[Test 1] Compacting large tool response in functionResponse...');
const optimized = runJigitPipeline(mockTurns, { keepRecentTurns: 1 });
assert.strictEqual(optimized.length, 3, 'Turn count must remain exactly 3');
assert.strictEqual(optimized[0].role, 'user', 'Turn 0 role must be user');
assert.strictEqual(optimized[1].role, 'model', 'Turn 1 role must be model');
assert.strictEqual(optimized[2].role, 'model', 'Turn 2 role must be model');

const frOutput = optimized[2].parts[0].functionResponse.response.output;
assert.ok(frOutput.includes('[JIGIT Engine: Compacted File: read_file'), 'Output must contain JIGIT preview marker');
assert.ok(frOutput.includes('capsule=jigit-'), 'Output must reference capsule ID');
assert.ok(frOutput.length < 1500, 'Compacted output must be under 1500 chars');

// Extract capsule id and verify persistent storage
const match = frOutput.match(/capsule=(jigit-[a-f0-9]+)/);
assert.ok(match, 'Must extract valid capsule ID');
const capsuleId = match[1];
const stored = getCapsule(capsuleId);
assert.ok(stored, 'Stored capsule must exist in capsule store');
assert.strictEqual(stored.content, bigFileContent, 'Stored capsule must match original full content');
console.log('  -> PASS: Large tool response compacted and retrievable via capsuleId:', capsuleId);

console.log('\n>>> ALL JIGIT TOKEN SAVER TESTS PASSED! <<<');
