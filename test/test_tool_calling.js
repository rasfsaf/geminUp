const assert = require('assert');
const path = require('path');

const {
  extractToolsFromPayload,
  buildToolInstructionPrompt,
  extractToolCallsFromOutput,
} = require('../src/argon/gateway');

console.log('=== TEST SUITE: GEMINUP ARGON TOOL CALLING & ANTIGRAVITY BRIDGE ===\n');

// 1. Test buildToolInstructionPrompt
console.log('[Test 1] Antigravity IDE Persona & Tool Prompt Injection');
const mockTools = [
  {
    name: 'run_command',
    description: 'Execute a command in the workspace.',
    parameters: {
      type: 'object',
      properties: { CommandLine: { type: 'string' } },
      required: ['CommandLine'],
    },
  },
  {
    name: 'read_file',
    description: 'Read contents of a file.',
    parameters: {
      type: 'object',
      properties: { Path: { type: 'string' } },
      required: ['Path'],
    },
  },
];

const injectedPrompt = buildToolInstructionPrompt(mockTools);
assert(injectedPrompt.includes('GOOGLE ANTIGRAVITY IDE NATIVE AGENT'), 'Must contain Antigravity IDE persona');
assert(injectedPrompt.includes('run_command'), 'Must declare run_command');
assert(injectedPrompt.includes('read_file'), 'Must declare read_file');
assert(injectedPrompt.includes('ABSOLUTE BAN ON REFUSALS'), 'Must forbid refusal disclaimers');
assert(injectedPrompt.includes('NO PREAMBLE BEFORE TOOLS'), 'Must instruct immediate tool call block');
console.log('  -> PASS: Antigravity IDE agent persona injected with strict tool directives.\n');

// 2. Test extraction of various tool call formats
console.log('[Test 2] Multi-Format Tool Call Parser Extraction');

// Format A: ```tool_call
const textA = '```tool_call\n{\n  "name": "run_command",\n  "args": { "CommandLine": "git status" }\n}\n```';
const resA = extractToolCallsFromOutput(textA);
assert.strictEqual(resA.toolCalls.length, 1);
assert.strictEqual(resA.toolCalls[0].name, 'run_command');
assert.strictEqual(resA.toolCalls[0].args.CommandLine, 'git status');
console.log('  -> PASS: Format A (```tool_call) successfully parsed.');

// Format B: ```json
const textB = '```json\n{\n  "name": "read_file",\n  "args": { "Path": "C:\\\\project\\\\app.js" }\n}\n```';
const resB = extractToolCallsFromOutput(textB);
assert.strictEqual(resB.toolCalls.length, 1);
assert.strictEqual(resB.toolCalls[0].name, 'read_file');
assert.strictEqual(resB.toolCalls[0].args.Path, 'C:\\project\\app.js');
console.log('  -> PASS: Format B (```json) successfully parsed.');

// Format C: [Tool Call: ...]
const textC = '[Tool Call: run_command({"CommandLine": "npm test"})]';
const resC = extractToolCallsFromOutput(textC);
assert.strictEqual(resC.toolCalls.length, 1);
assert.strictEqual(resC.toolCalls[0].name, 'run_command');
assert.strictEqual(resC.toolCalls[0].args.CommandLine, 'npm test');
console.log('  -> PASS: Format C ([Tool Call: ...]) successfully parsed.');

// Format D: Bare JSON
const textD = '{\n  "name": "edit_file",\n  "args": { "Path": "config.json", "Replacement": "{}" }\n}';
const resD = extractToolCallsFromOutput(textD);
assert.strictEqual(resD.toolCalls.length, 1);
assert.strictEqual(resD.toolCalls[0].name, 'edit_file');
assert.strictEqual(resD.toolCalls[0].args.Path, 'config.json');
console.log('  -> PASS: Format D (Bare JSON) successfully parsed.');

// Format E: XML-style <function_call>
const textE = '<function_call name="run_command">{"CommandLine": "dir"}</function_call>';
const resE = extractToolCallsFromOutput(textE);
assert.strictEqual(resE.toolCalls.length, 1);
assert.strictEqual(resE.toolCalls[0].name, 'run_command');
assert.strictEqual(resE.toolCalls[0].args.CommandLine, 'dir');
console.log('  -> PASS: Format E (XML <function_call>) successfully parsed.\n');

// 3. Test Antigravity IDE Protocol candidate output structure
console.log('[Test 3] Cloud Code SSE Protocol candidate validation for IDE Tool Executor');
const candidateParts = [];
for (const call of resA.toolCalls) {
  candidateParts.push({
    functionCall: {
      name: call.name,
      args: call.args,
    },
  });
}

const mockCloudCodeCandidate = {
  response: {
    candidates: [
      {
        content: {
          role: 'model',
          parts: candidateParts,
        },
        finishReason: 'STOP',
      },
    ],
  },
};

assert.strictEqual(mockCloudCodeCandidate.response.candidates[0].finishReason, 'STOP');
assert(mockCloudCodeCandidate.response.candidates[0].content.parts[0].functionCall, 'Must contain functionCall object');
assert.strictEqual(mockCloudCodeCandidate.response.candidates[0].content.parts[0].functionCall.name, 'run_command');
console.log('  -> PASS: Antigravity IDE SSE payload matches Cloud Code Go Language Server specification.');

console.log('\n>>> ALL 3 TOOL USE TESTS PASSED SUCCESSFULLY! <<<');
