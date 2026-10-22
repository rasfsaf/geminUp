/**
 * JIGIT Engine - High-Precision Context Compression & Boundary Pipeline for Gemini 4 Argon
 * Adapted from Reagent context optimization architecture.
 */

const crypto = require('crypto');
const { saveCapsule } = require('./capsule-store');

function getDeterministicCapsuleId(content) {
  const hash = crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 10);
  return 'jigit-' + hash;
}

function isAgentToolResultText(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const trimmed = text.trim();
  if (/^\[[\w_.-]+\s+for\s+['"][^'"]+['"]\]\s*Result:/i.test(trimmed)) return true;
  if (/^\[(?:execute_command|read_file|write_file|edit_file|apply_diff|replace_in_file|search_files|list_files|run_command)[^\]]*\]\s*Result:/i.test(trimmed)) return true;
  if (/<(?:tool_result|file_content|read_file_result|execute_command_result)\b/i.test(trimmed)) return true;
  return false;
}

function isNoiseContent(text) {
  if (typeof text !== 'string' || text.length < 80) return false;
  return (
    text.includes('diff --git') ||
    text.includes('index ') ||
    text.includes('npm test') ||
    text.includes('pytest') ||
    text.includes('cargo test') ||
    text.includes('go test') ||
    text.includes('vitest') ||
    text.includes('jest') ||
    text.includes('Traceback (most recent call last):') ||
    text.includes('SyntaxError:') ||
    text.includes('TypeError:') ||
    text.includes('AssertionError:') ||
    text.includes('at Module._compile') ||
    text.includes('node:internal/') ||
    text.includes('find_by_name') ||
    text.includes('grep_search') ||
    text.includes('directory analysis') ||
    text.includes('BUILD FAILED') ||
    text.includes('FAILED (failures=') ||
    text.includes('FAILED (errors=') ||
    isAgentToolResultText(text)
  );
}

function compactFileBlock(filepath, content, capsuleId) {
  saveCapsule(capsuleId, content, { category: 'File', filepath });
  const lines = content.split('\n');
  const preview = lines.slice(0, 4).join('\n').slice(0, 250);
  const tail = lines.slice(-2).join('\n').slice(0, 150);
  const totalLength = content.length;
  const label = filepath ? `File: ${filepath}` : 'File/Code Dump';
  return `[JIGIT Engine: Compacted ${label} (${totalLength} bytes; capsule=${capsuleId}). Use MCP tool jigit_restore_capsule('${capsuleId}') to inspect full original content. Preview:\n${preview}\n... [${totalLength - preview.length - tail.length} bytes omitted for low latency] ...\n${tail}]`;
}

function compactNoiseText(text, category = 'Diagnostic Log') {
  if (text.length <= 1200) return text;
  const capsuleId = getDeterministicCapsuleId(text);
  saveCapsule(capsuleId, text, { category });
  const head = text.slice(0, 500);
  const tail = text.slice(-400);
  const omitted = text.length - 900;
  return `${head}\n\n[JIGIT Engine: ${category} truncated (${omitted} chars omitted; capsule=${capsuleId}). Use MCP tool jigit_restore_capsule('${capsuleId}') if full details are needed.]\n\n${tail}`;
}

function isErrorOrFailure(text) {
  if (typeof text !== 'string') return false;
  return /\b(?:error|failed|failure|exception|fatal|traceback|could not apply|invalid patch|old_string|not found|did not match)\b/i.test(text);
}

function optimizeTurnWithJigit(turn, isRecent, isInitial) {
  if (!turn) return turn;
  if (typeof turn === 'string') {
    if (!isRecent && !isInitial && turn.length > 2500) {
      return compactNoiseText(turn, 'Historical Message');
    }
    return turn;
  }

  // Handle plain text property
  if (typeof turn.text === 'string' && !turn.parts && !turn.content) {
    if (!isRecent && !isInitial && turn.text.length > 2500) {
      return { ...turn, text: compactNoiseText(turn.text, 'Historical Message') };
    }
    return turn;
  }

  // Handle string content property (OpenAI format)
  if (typeof turn.content === 'string' && !turn.parts) {
    if (!isRecent && !isInitial && turn.content.length > 2500) {
      return { ...turn, content: compactNoiseText(turn.content, 'Historical Message') };
    }
    return turn;
  }

  // Handle array content property (Anthropic format: tool_result / text blocks)
  if (Array.isArray(turn.content) && !turn.parts) {
    const optimizedContent = turn.content.map((part) => {
      if (!part || typeof part !== 'object') return part;
      if (part.type === 'tool_result' || part.type === 'tool_call_output') {
        const textVal = typeof part.content === 'string' ? part.content : (typeof part.output === 'string' ? part.output : '');
        if (textVal.length > (isRecent ? 4000 : 1500)) {
          const compacted = compactNoiseText(textVal, 'Tool Result');
          return { ...part, content: compacted };
        }
      } else if (typeof part.text === 'string' && !isRecent && !isInitial && part.text.length > 2500) {
        return { ...part, text: compactNoiseText(part.text, 'Historical Part') };
      }
      return part;
    });
    return { ...turn, content: optimizedContent };
  }

  if (!Array.isArray(turn.parts)) return turn;

  const optimizedParts = turn.parts.map((part) => {
    if (!part) return part;

    // 1. Tool Responses (functionResponse)
    if (part.functionResponse) {
      const fr = part.functionResponse;
      const resp = fr.response;
      let targetKey = null;
      let out = '';

      if (resp && typeof resp === 'object') {
        if (typeof resp.output === 'string') {
          targetKey = 'output';
          out = resp.output;
        } else if (typeof resp.result === 'string') {
          targetKey = 'result';
          out = resp.result;
        } else if (typeof resp.content === 'string') {
          targetKey = 'content';
          out = resp.content;
        }
      } else if (typeof resp === 'string') {
        out = resp;
      }

      if (out) {
        const isErr = isErrorOrFailure(out);
        // If it's a recent turn or an error, give it a larger allowance
        const limit = isRecent ? (isErr ? 8000 : 3000) : (isErr ? 2500 : 1200);

        if (out.length > limit) {
          const toolName = fr.name || 'tool';
          const capsuleId = getDeterministicCapsuleId(out);
          const isFile =
            toolName.includes('read') ||
            toolName.includes('file') ||
            out.startsWith('//') ||
            out.startsWith('import ') ||
            out.startsWith('const ') ||
            out.startsWith('def ') ||
            out.startsWith('<!DOCTYPE');

          const compacted = isFile
            ? compactFileBlock(toolName, out, capsuleId)
            : compactNoiseText(out, `Tool Result: ${toolName}`);

          if (targetKey && resp && typeof resp === 'object') {
            return {
              ...part,
              functionResponse: {
                ...fr,
                response: {
                  ...resp,
                  [targetKey]: compacted,
                },
              },
            };
          }

          return {
            ...part,
            functionResponse: {
              ...fr,
              response: compacted,
            },
          };
        }
      }
      return part;
    }

    // 2. Text parts with noise or huge code dumps
    if (typeof part.text === 'string') {
      const txt = part.text;
      if (!isRecent && !isInitial && txt.length > 2500) {
        if (isNoiseContent(txt)) {
          return { ...part, text: compactNoiseText(txt, 'Console/Diagnostic Log') };
        }
        const capsuleId = getDeterministicCapsuleId(txt);
        return { ...part, text: compactFileBlock('', txt, capsuleId) };
      }
    }

    return part;
  });

  return { ...turn, parts: optimizedParts };
}

/**
 * JIGIT Engine Pipeline:
 * - Preserves Turn Structure & Schema Validity (alternating user/model roles, functionCall/functionResponse pairing)
 * - Preserves Initial Task Intent (Turn 0)
 * - Preserves Active Workflow (Recent turns + pending tool calls)
 * - Compacts tool responses (read_file, run_command, terminal dumps) and noisy text into capsules
 * - Saves up to 70-90% prompt tokens while keeping full context accessible via MCP jigit_restore_capsule
 */
function runJigitPipeline(turnsList, options = {}) {
  if (!Array.isArray(turnsList) || turnsList.length === 0) return [];
  const totalTurns = turnsList.length;
  const keepRecentTurns = options.keepRecentTurns || 8;

  // In native Google Cloud Code / Gemini API, arbitrary slicing of turns risks:
  // 1. Consecutive identical roles (user -> user), which triggers HTTP 400 Bad Request
  // 2. Separating functionCall (model) from functionResponse (user), which triggers HTTP 400
  // Instead, 95% of token consumption in coding workflows comes from massive tool outputs
  // (file dumps, compiler errors, build logs) and historical text noise inside turn parts.
  // By compacting all tool outputs and noise into capsules while preserving the turn graph,
  // we achieve massive token reduction with 100% schema compliance.
  return turnsList.map((turn, index) => {
    const isInitial = index === 0;
    const isRecent = index >= totalTurns - keepRecentTurns;
    return optimizeTurnWithJigit(turn, isRecent, isInitial);
  });
}

function enforceJigitBudget(promptText, maxChars = 38000) {
  if (!promptText || promptText.length <= maxChars) return promptText;
  const headSize = Math.round(maxChars * 0.3);
  const tailSize = Math.round(maxChars * 0.7);
  const head = promptText.slice(0, headSize);
  const tail = promptText.slice(-tailSize);
  const omitted = promptText.length - (headSize + tailSize);
  return `${head}\n\n[JIGIT Engine: Context budget enforced. ${omitted} chars omitted for fast TTFT ...]\n\n${tail}`;
}

module.exports = {
  runJigitPipeline,
  enforceJigitBudget,
  getDeterministicCapsuleId,
  isNoiseContent,
  compactNoiseText,
  compactFileBlock,
};
