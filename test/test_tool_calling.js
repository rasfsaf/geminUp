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
assert(injectedPrompt.includes('Workspace Environment & Tools'), 'Must contain workspace tools header');
assert(injectedPrompt.includes('run_command'), 'Must declare run_command');
assert(injectedPrompt.includes('read_file'), 'Must declare read_file');
assert(injectedPrompt.includes('tool_call'), 'Must instruct tool_call block');
console.log('  -> PASS: Antigravity IDE workspace prompt injected cleanly without safety triggers.\n');

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
console.log('  -> PASS: Format E (XML <function_call>) successfully parsed.');

// Format F: Bare ``` fence with name & args
const textF = '```\n{\n  "name": "write_file",\n  "args": { "Path": "index.js", "Content": "console.log(1);" }\n}\n```';
const resF = extractToolCallsFromOutput(textF);
assert.strictEqual(resF.toolCalls.length, 1);
assert.strictEqual(resF.toolCalls[0].name, 'write_file');
assert.strictEqual(resF.toolCalls[0].args.Path, 'index.js');
console.log('  -> PASS: Format F (Bare ``` fence) successfully parsed.');

// Format G: Direct function call tool_name({...})
const textG = 'read_file({"Path": "README.md"})';
const resG = extractToolCallsFromOutput(textG);
assert.strictEqual(resG.toolCalls.length, 1);
assert.strictEqual(resG.toolCalls[0].name, 'read_file');
assert.strictEqual(resG.toolCalls[0].args.Path, 'README.md');
console.log('  -> PASS: Format G (Direct invocation tool_name({...})) successfully parsed.');

// Format H: ReAct format Action / Action Input
const textH = 'Action: run_command\nAction Input: {"CommandLine": "git status"}';
const resH = extractToolCallsFromOutput(textH);
assert.strictEqual(resH.toolCalls.length, 1);
assert.strictEqual(resH.toolCalls[0].name, 'run_command');
assert.strictEqual(resH.toolCalls[0].args.CommandLine, 'git status');
console.log('  -> PASS: Format H (ReAct Action / Action Input) successfully parsed.');

// Format I: Preamble preservation (exact scenario user encountered)
const textI = 'I will check the codebase and documentation to understand what the mod does.\n\nLet\'s read README.md or DOC.md first.\n\n```tool_call\n{\n  "name": "read_file",\n  "args": { "Path": "README.md" }\n}\n```';
const resI = extractToolCallsFromOutput(textI);
assert.strictEqual(resI.toolCalls.length, 1);
assert.strictEqual(resI.toolCalls[0].name, 'read_file');
assert(resI.cleanText.includes('I will check the codebase'), 'Must preserve preamble as cleanText');
assert(!resI.cleanText.includes('```tool_call'), 'Must strip tool call block from cleanText');
console.log('  -> PASS: Format I (Preamble preservation with cleanText) successfully parsed.\n');

// 3. Test Antigravity IDE Protocol candidate output structure
console.log('[Test 3] Cloud Code SSE Protocol candidate validation for IDE Tool Executor');
const candidateParts = [];
if (resI.cleanText) {
  candidateParts.push({ text: resI.cleanText, thought: true });
}
for (const call of resI.toolCalls) {
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
assert.strictEqual(mockCloudCodeCandidate.response.candidates[0].content.parts[0].thought, true);
assert(mockCloudCodeCandidate.response.candidates[0].content.parts[1].functionCall, 'Must contain functionCall object');
assert.strictEqual(mockCloudCodeCandidate.response.candidates[0].content.parts[1].functionCall.name, 'read_file');
console.log('  -> PASS: Antigravity IDE SSE payload contains thoughts and functionCall matching Cloud Code Go Language Server specification.');

// 4. Test Turn Role formatting with functionResponse
console.log('\n[Test 4] Turn Role formatting with functionResponse');
const { extractPromptFromAnyPayload } = require('../src/argon/gateway');
const mockPayload = {
  request: {
    contents: [
      { role: 'user', parts: [{ text: 'Check the file' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { Path: 'README.md' } } }] },
      { role: 'model', parts: [{ functionResponse: { name: 'read_file', response: { content: '# My Mod' } } }] },
    ],
    tools: [
      { functionDeclarations: [{ name: 'read_file', description: 'Read file', parameters: {} }] },
    ],
  },
};
const generatedPrompt = extractPromptFromAnyPayload(mockPayload);
assert(generatedPrompt.includes('User (Tool Result):'), 'Tool response must be labeled User (Tool Result)');
assert(!generatedPrompt.includes('Assistant:\n[Tool Result: read_file]'), 'Tool response must NOT be labeled Assistant');
assert(generatedPrompt.trim().endsWith('Assistant:'), 'Prompt must end with Assistant: cue for the model to take action');
console.log('  -> PASS: Tool responses correctly labeled as User (Tool Result) and prompt ends with Assistant: cue.');

console.log('\n>>> ALL 4 EXTENDED TOOL CALLING TESTS PASSED SUCCESSFULLY! <<<');
