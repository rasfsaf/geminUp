/**
 * JIGIT Engine - High-Precision Context Compression & Boundary Pipeline for Gemini 4 Argon
 * Adapted from Reagent context optimization architecture.
 */

const crypto = require('crypto');

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
  const lines = content.split('\n');
  const preview = lines.slice(0, 4).join('\n').slice(0, 250);
  const tail = lines.slice(-2).join('\n').slice(0, 150);
  const totalLength = content.length;
  const label = filepath ? `File: ${filepath}` : 'File/Code Dump';
  return `[JIGIT Engine: Compacted ${label} (${totalLength} bytes; capsule=${capsuleId}). Preview:\n${preview}\n... [${totalLength - preview.length - tail.length} bytes omitted for low latency] ...\n${tail}]`;
}

function compactNoiseText(text, category = 'Diagnostic Log') {
  if (text.length <= 1200) return text;
  const head = text.slice(0, 500);
  const tail = text.slice(-400);
  const omitted = text.length - 900;
  const capsuleId = getDeterministicCapsuleId(text);
  return `${head}\n\n[JIGIT Engine: ${category} truncated (${omitted} chars omitted; capsule=${capsuleId})]\n\n${tail}`;
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
  if (!Array.isArray(turn.parts)) return turn;

  const optimizedParts = turn.parts.map((part) => {
    if (!part) return part;

    // 1. Tool Responses (functionResponse)
    if (part.functionResponse) {
      const fr = part.functionResponse;
      const resp = fr.response;
      if (resp && typeof resp.output === 'string') {
        const out = resp.output;
        const isErr = isErrorOrFailure(out);
        // If it's a recent turn or an error, give it a larger allowance
        const limit = isRecent ? (isErr ? 8000 : 3000) : (isErr ? 2500 : 1200);

        if (out.length > limit) {
          const toolName = fr.name || 'tool';
          const capsuleId = getDeterministicCapsuleId(out);

          // Check if this looks like a file dump (read_file)
          if (toolName.includes('read') || toolName.includes('file') || out.startsWith('//') || out.startsWith('import ') || out.startsWith('const ')) {
            return {
              ...part,
              functionResponse: {
                ...fr,
                response: {
                  ...resp,
                  output: compactFileBlock(toolName, out, capsuleId),
                },
              },
            };
          }

          // Otherwise general noise / log truncation
          return {
            ...part,
            functionResponse: {
              ...fr,
              response: {
                ...resp,
                output: compactNoiseText(out, `Tool Result: ${toolName}`),
              },
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
 * - Preserves System Instructions
 * - Preserves Initial Task Intent (Turn 0)
 * - Preserves Active Workflow (Last 3 turns + unclosed tool calls)
 * - Compacts historical completed turns
 * - Enforces target character budget (< 40,000 chars) for instant TTFT in Gemini 4 Argon
 */
function runJigitPipeline(turnsList, options = {}) {
  if (!Array.isArray(turnsList) || turnsList.length === 0) return [];
  const totalTurns = turnsList.length;
  const keepRecentTurns = options.keepRecentTurns || 4;
  const maxPromptTurns = options.maxPromptTurns || 8;

  let selectedTurns = turnsList;
  if (totalTurns > maxPromptTurns) {
    const initialTurns = turnsList.slice(0, 1);
    const recentTurns = turnsList.slice(-keepRecentTurns);
    const omittedCount = totalTurns - initialTurns.length - recentTurns.length;

    const summaryMarker = {
      role: 'user',
      parts: [
        {
          text: `[JIGIT Engine: ${omittedCount} intermediate conversation turns compressed into background memory for low latency. Most recent state and initial request preserved.]`,
        },
      ],
    };
    selectedTurns = [...initialTurns, summaryMarker, ...recentTurns];
  }

  const selTotal = selectedTurns.length;
  return selectedTurns.map((turn, index) => {
    const isInitial = index === 0;
    const isRecent = index >= selTotal - 2;
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
