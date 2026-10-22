const { runJigitPipeline } = require('../src/argon/jigit-engine');

const mockTurns = [
  { role: 'user', parts: [{ text: 'Explain this' }] },
  {
    role: 'model',
    parts: [{
      text: '[JIGIT Engine: Compacted File/Code Dump (3372 bytes; capsule=jigit-cbe33a0da7). Use MCP tool jigit_restore_capsule(\'jigit-cbe33a0da7\') if full details are needed.]\n\nHere is the code explanation:\n```js\nconsole.log("hello");\n```\n' + 'More explanation text. '.repeat(200)
    }]
  },
  { role: 'user', parts: [{ text: 'What is next?' }] }
];

const res = runJigitPipeline(mockTurns, { keepRecentTurns: 1 });
const cleanedText = res[1].parts[0].text;

console.log('Result text starts with:', cleanedText.slice(0, 80));
console.log('Contains JIGIT banner:', cleanedText.includes('JIGIT Engine'));

if (cleanedText.includes('JIGIT Engine')) {
  console.error('FAIL: JIGIT banner was NOT stripped from model turn!');
  process.exit(1);
} else {
  console.log('PASS: JIGIT banner successfully purged and model code answer preserved intact!');
}
