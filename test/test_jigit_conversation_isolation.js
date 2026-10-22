const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set isolated test directory
const testDir = path.join(os.tmpdir(), 'geminUp-test-convo-' + Date.now());
process.env.ARGON_CAPSULE_DIR = testDir;

const {
  saveCapsule,
  getCapsule,
  listCapsules,
  searchCapsules,
  setActiveConversation,
  getActiveConversationId,
} = require('../src/argon/capsule-store');

const { runJigitPipeline } = require('../src/argon/jigit-engine');

console.log('=== TEST SUITE: JIGIT CONVERSATION ISOLATION & SCOPING ===');

// Test 1: Active conversation state
console.log('[Test 1] Setting active conversation ID...');
const convo1 = 'chat-session-1111-aaaa';
const convo2 = 'chat-session-2222-bbbb';

setActiveConversation(convo1);
assert.strictEqual(getActiveConversationId(), convo1, 'Active conversation ID must match');
console.log('  -> PASS: Active conversation successfully tracked');

// Test 2: Saving capsules in distinct conversations
console.log('[Test 2] Saving capsules scoped to Chat 1 and Chat 2...');
saveCapsule('jigit-c1-01', 'Secret content for chat 1 error: Segmentation fault in main.cpp', {
  category: 'Diagnostic Log',
  conversationId: convo1,
});

saveCapsule('jigit-c2-01', 'Secret content for chat 2 error: NullPointerException in UserServiceImpl.java', {
  category: 'Diagnostic Log',
  conversationId: convo2,
});

assert.ok(fs.existsSync(path.join(testDir, convo1, 'jigit-c1-01.json')), 'Chat 1 subfolder must contain capsule');
assert.ok(fs.existsSync(path.join(testDir, convo2, 'jigit-c2-01.json')), 'Chat 2 subfolder must contain capsule');
assert.ok(fs.existsSync(path.join(testDir, 'jigit-c1-01.json')), 'Root folder must contain capsule for global lookup');
console.log('  -> PASS: Capsule files organized in conversation directories');

// Test 3: listCapsules scoping
console.log('[Test 3] Testing listCapsules isolation...');
const list1 = listCapsules(10, convo1);
assert.strictEqual(list1.length, 1, 'Chat 1 list should have exactly 1 item');
assert.strictEqual(list1[0].id, 'jigit-c1-01', 'Chat 1 item must be jigit-c1-01');

const list2 = listCapsules(10, convo2);
assert.strictEqual(list2.length, 1, 'Chat 2 list should have exactly 1 item');
assert.strictEqual(list2[0].id, 'jigit-c2-01', 'Chat 2 item must be jigit-c2-01');
console.log('  -> PASS: listCapsules returns strictly chat-scoped results');

// Test 4: searchCapsules scoping
console.log('[Test 4] Testing searchCapsules isolation...');
const search1 = searchCapsules('Segmentation', 5, convo1);
assert.strictEqual(search1.length, 1, 'Should find match in Chat 1');

const search2InConvo1 = searchCapsules('NullPointerException', 5, convo1);
assert.strictEqual(search2InConvo1.length, 0, 'NullPointerException from Chat 2 must NOT appear in Chat 1 search');

const search2InConvo2 = searchCapsules('NullPointerException', 5, convo2);
assert.strictEqual(search2InConvo2.length, 1, 'NullPointerException must appear in Chat 2 search');
console.log('  -> PASS: searchCapsules strictly prevents cross-conversation leakage');

// Test 5: getCapsule restoration
console.log('[Test 5] Testing getCapsule restoration...');
const c1 = getCapsule('jigit-c1-01', convo1);
assert.ok(c1 && c1.content.includes('Segmentation fault'), 'Capsule 1 restored correctly');

const c2 = getCapsule('jigit-c2-01'); // Without explicit convo ID
assert.ok(c2 && c2.content.includes('NullPointerException'), 'Capsule 2 restored via global lookup');
console.log('  -> PASS: getCapsule restores correctly both scoped and unscoped');

// Test 6: runJigitPipeline with conversationId option
console.log('[Test 6] Testing runJigitPipeline with conversationId option...');
const sampleTurn = [
  {
    role: 'user',
    parts: [{ text: 'Compile project' }],
  },
  {
    role: 'model',
    parts: [
      {
        functionResponse: {
          name: 'run_command',
          response: {
            output: 'Long compilation output: '.repeat(200),
          },
        },
      },
    ],
  },
];

const convo3 = 'chat-session-3333-cccc';
const optimized = runJigitPipeline(sampleTurn, { conversationId: convo3 });
const outText = optimized[1].parts[0].functionResponse.response.output;
assert.ok(outText.includes('capsule=jigit-'), 'Tool output was compacted into a capsule');
const capMatch = outText.match(/capsule=(jigit-[a-f0-9]+)/);
assert.ok(capMatch, 'Capsule id found in output');

const cap3 = getCapsule(capMatch[1], convo3);
assert.ok(cap3, 'Capsule saved under convo3 directory');
assert.strictEqual(cap3.conversationId, convo3, 'Capsule record has correct conversationId');
console.log('  -> PASS: Pipeline successfully routes compacted items to chat conversation folder');

// Cleanup test dir
fs.rmSync(testDir, { recursive: true, force: true });
console.log('\n>>> ALL JIGIT CONVERSATION ISOLATION TESTS PASSED! <<<');
