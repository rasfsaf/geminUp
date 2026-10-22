/**
 * JIGIT Engine - High-Precision Context Compression & Boundary Pipeline for Antigravity & Gemini
 * Automatically compacts historical turns, tool outputs, terminal logs, and historical images.
 * Keeps initial turn (intent) and recent turns pristine while maintaining valid Gemini schema.
 */

const crypto = require('crypto');
const { saveCapsule } = require('./capsule-store');
const { createCompressionTracker, logCompressionSummary } = require('./jigit-logger');

function getDeterministicCapsuleId(content, prefix = 'jigit') {
  const hash = crypto.createHash('sha256').update(String(content || '')).digest('hex').slice(0, 10);
  return `${prefix}-${hash}`;
}

function isAgentToolResultText(text) {
  if (typeof text !== 'string') return false;
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
    text.includes('PASS ') ||
    text.includes('FAIL ')
  );
}

function compactFileBlock(filepath, content, capsuleId, options = {}) {
  saveCapsule(capsuleId, content, {
    category: 'File',
    filepath,
    conversationId: options.conversationId || null,
  });
  const lines = content.split('\n');
  const preview = lines.slice(0, 4).join('\n').slice(0, 250);
  const tail = lines.slice(-2).join('\n').slice(0, 150);
  const totalLength = content.length;
  const label = filepath ? `File: ${filepath}` : 'File/Code Dump';
  return `[JIGIT Engine: Compacted ${label} (${totalLength} bytes; capsule=${capsuleId}). Use MCP tool jigit_restore_capsule('${capsuleId}') to inspect full original content. Preview:\n${preview}\n... [${totalLength - preview.length - tail.length} bytes omitted for low latency] ...\n${tail}]`;
}

function breakRepetitiveLoops(text) {
  if (typeof text !== 'string' || text.length < 100) return text;

  // 1. Line-level repetition collapse
  const lines = text.split('\n');
  if (lines.length >= 4) {
    const deduped = [];
    let repeatCount = 0;
    let prevLine = null;
    let changed = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.length > 20 && trimmed === prevLine) {
        repeatCount++;
        changed = true;
      } else {
        if (repeatCount >= 2) {
          deduped.push(`[JIGIT: Repetitive reasoning loop collapsed (${repeatCount} redundant lines purged)]`);
        }
        repeatCount = 0;
        prevLine = trimmed.length > 20 ? trimmed : null;
        deduped.push(line);
      }
    }
    if (repeatCount >= 2) {
      deduped.push(`[JIGIT: Repetitive reasoning loop collapsed (${repeatCount} redundant lines purged)]`);
    }
    if (changed) {
      text = deduped.join('\n');
    }
  }

  // 2. Continuous phrase/sentence repetition collapse (mode collapse)
  const loopRegex = /((?:.{20,250}?))(?:\s*\1){2,}/gis;
  if (loopRegex.test(text)) {
    text = text.replace(loopRegex, (match, unit) => {
      const count = Math.max(2, Math.round(match.length / unit.length));
      return `${unit.trim()}\n[JIGIT: Repetitive reasoning loop collapsed (${count} redundant cycles purged)]\n`;
    });
  }

  return text;
}

function compactNoiseText(text, category = 'Diagnostic Log', options = {}) {
  if (text.length <= 1200) return text;
  const capsuleId = getDeterministicCapsuleId(text);
  saveCapsule(capsuleId, text, {
    category,
    conversationId: options.conversationId || null,
  });
  const head = text.slice(0, 500);
  const tail = text.slice(-400);
  const omitted = text.length - 900;
  return `${head}\n\n[JIGIT Engine: ${category} truncated (${omitted} chars omitted; capsule=${capsuleId}). Use MCP tool jigit_restore_capsule('${capsuleId}') if full details are needed.]\n\n${tail}`;
}

function isErrorOrFailure(text) {
  if (typeof text !== 'string') return false;
  return /\b(?:error|failed|failure|exception|fatal|traceback|could not apply|invalid patch|old_string|not found|did not match)\b/i.test(text);
}

function optimizeTurnWithJigit(turn, isRecent, isInitial, options = {}) {
  if (!turn) return turn;
  const tracker = options.tracker || null;

  if (typeof turn === 'string') {
    if (!isRecent && !isInitial && turn.length > 2500) {
      const compacted = compactNoiseText(turn, 'Historical Message', options);
      if (tracker && compacted !== turn) {
        tracker.recordItem({
          type: 'Historical Message',
          name: 'plain text',
          originalSize: turn.length,
          compactedSize: compacted.length,
          capsuleId: getDeterministicCapsuleId(turn),
        });
      }
      return compacted;
    }
    return turn;
  }

  // Handle plain text property
  if (typeof turn.text === 'string' && !turn.parts && !turn.content) {
    let currentText = breakRepetitiveLoops(turn.text);
    if (!isRecent && !isInitial && currentText.length > 2500) {
      const compacted = compactNoiseText(currentText, 'Historical Message', options);
      if (tracker && compacted !== currentText) {
        tracker.recordItem({
          type: 'Historical Message',
          name: 'turn.text',
          originalSize: currentText.length,
          compactedSize: compacted.length,
          capsuleId: getDeterministicCapsuleId(currentText),
        });
      }
      return { ...turn, text: compacted };
    }
    if (currentText !== turn.text) {
      return { ...turn, text: currentText };
    }
    return turn;
  }

  // Handle string content property (OpenAI format)
  if (typeof turn.content === 'string' && !turn.parts) {
    let currentContent = breakRepetitiveLoops(turn.content);
    if (!isRecent && !isInitial && currentContent.length > 2500) {
      const compacted = compactNoiseText(currentContent, 'Historical Message', options);
      if (tracker && compacted !== currentContent) {
        tracker.recordItem({
          type: 'Historical Message',
          name: 'turn.content',
          originalSize: currentContent.length,
          compactedSize: compacted.length,
          capsuleId: getDeterministicCapsuleId(currentContent),
        });
      }
      return { ...turn, content: compacted };
    }
    if (currentContent !== turn.content) {
      return { ...turn, content: currentContent };
    }
    return turn;
  }

  // Handle array of content blocks (Anthropic / modern formats)
  if (Array.isArray(turn.content) && !turn.parts) {
    turn = { ...turn, parts: turn.content };
  }

  if (!Array.isArray(turn.parts)) return turn;

  const optimizedParts = turn.parts.map((part) => {
    if (!part || typeof part !== 'object') return part;

    // A. Generic tool result / output blocks
    if (part.type === 'tool_result' || part.type === 'tool_call_output') {
      const textVal = typeof part.content === 'string' ? part.content : (typeof part.output === 'string' ? part.output : '');
      if (textVal.length > (isRecent ? 4000 : 1500)) {
        const compacted = compactNoiseText(textVal, 'Tool Result', options);
        const capsuleId = getDeterministicCapsuleId(textVal);
        if (tracker && compacted !== textVal) {
          tracker.recordItem({
            type: 'Tool Result',
            name: part.name || part.tool_name || 'tool_result',
            originalSize: textVal.length,
            compactedSize: compacted.length,
            capsuleId,
          });
        }
        return {
          ...part,
          content: typeof part.content === 'string' ? compacted : part.content,
          output: typeof part.output === 'string' ? compacted : part.output,
        };
      }
      return part;
    }

    // B. Native Gemini functionResponse
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
      }

      if (targetKey && out.length > 0) {
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
            ? compactFileBlock(toolName, out, capsuleId, options)
            : compactNoiseText(out, `Tool: ${toolName}`, options);

          if (tracker && compacted !== out) {
            tracker.recordItem({
              type: 'Tool Result',
              name: toolName,
              originalSize: out.length,
              compactedSize: compacted.length,
              capsuleId,
            });
          }

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
      }
      return part;
    }

    // C. Model reasoning / thinking parts (archive historical thinking & break runaway loops)
    if (part.thought === true || part.type === 'thinking') {
      const thoughtText = typeof part.text === 'string' ? part.text : (typeof part.thinking === 'string' ? part.thinking : '');
      if (!isRecent && thoughtText && thoughtText.length > 80) {
        const capsuleId = getDeterministicCapsuleId(thoughtText);
        saveCapsule(capsuleId, thoughtText, { category: 'Historical Thought', conversationId: options.conversationId });
        const compacted = `[JIGIT: Historical reasoning trajectory archived (${thoughtText.length} chars; capsule=${capsuleId})]`;
        if (tracker) {
          tracker.recordItem({
            type: 'Historical Thought',
            name: 'turn.parts.thought',
            originalSize: thoughtText.length,
            compactedSize: compacted.length,
            capsuleId,
          });
        }
        return {
          ...part,
          text: compacted,
        };
      }
      if (thoughtText && thoughtText.length > 100) {
        const broken = breakRepetitiveLoops(thoughtText);
        if (broken !== thoughtText) {
          if (tracker) {
            tracker.recordItem({
              type: 'Thought Loop Breaker',
              name: 'turn.parts.thought',
              originalSize: thoughtText.length,
              compactedSize: broken.length,
              capsuleId: getDeterministicCapsuleId(thoughtText),
            });
          }
          return { ...part, text: broken };
        }
      }
    }

    // D. Text parts with noise, huge code dumps, or repeating loops
    if (typeof part.text === 'string') {
      let txt = breakRepetitiveLoops(part.text);
      if (tracker && txt !== part.text) {
        tracker.recordItem({
          type: 'Loop Breaker',
          name: 'turn.parts.text',
          originalSize: part.text.length,
          compactedSize: txt.length,
          capsuleId: getDeterministicCapsuleId(part.text),
        });
      }

      if (!isRecent && !isInitial && txt.length > 2500) {
        if (isNoiseContent(txt)) {
          const compacted = compactNoiseText(txt, 'Console/Diagnostic Log', options);
          const capsuleId = getDeterministicCapsuleId(txt);
          if (tracker && compacted !== txt) {
            tracker.recordItem({
              type: 'Diagnostic Log',
              name: 'terminal output',
              originalSize: txt.length,
              compactedSize: compacted.length,
              capsuleId,
            });
          }
          return { ...part, text: compacted };
        }
        if (isAgentToolResultText(txt) || txt.includes('```')) {
          const capsuleId = getDeterministicCapsuleId(txt);
          const compacted = compactFileBlock('', txt, capsuleId, options);
          if (tracker && compacted !== txt) {
            tracker.recordItem({
              type: 'Historical Code',
              name: 'code snippet',
              originalSize: txt.length,
              compactedSize: compacted.length,
              capsuleId,
            });
          }
          return { ...part, text: compacted };
        }
      }
      if (txt !== part.text) {
        return { ...part, text: txt };
      }
    }

    // E. Native Gemini inlineData (Images & Binary Attachments)
    if (part.inlineData && typeof part.inlineData === 'object') {
      const inline = part.inlineData;
      const dataStr = typeof inline.data === 'string' ? inline.data : '';
      const mime = inline.mimeType || 'image/png';

      // Only compact historical turns (!isRecent && !isInitial)
      // Recent turns MUST remain pristine so Gemini Vision can inspect new images
      if (!isRecent && !isInitial && dataStr.length > 512) {
        const capsuleId = getDeterministicCapsuleId(dataStr, 'jigit-img');
        saveCapsule(capsuleId, dataStr, {
          mimeType: mime,
          size: dataStr.length,
          type: 'image',
          category: 'Image',
          conversationId: options.conversationId || null,
        }, options);

        const sizeKb = (dataStr.length / 1024).toFixed(1);
        const placeholder = `[JIGIT Engine: Historical image (${mime}, ${sizeKb} KB) analyzed and archived to capsule ${capsuleId}. Use MCP tool jigit_restore_capsule('${capsuleId}') to inspect original image.]`;

        if (tracker) {
          tracker.recordItem({
            type: 'Historical Image',
            name: mime,
            originalSize: dataStr.length,
            compactedSize: placeholder.length,
            capsuleId,
            details: `${sizeKb} KB`,
          });
        }

        return { text: placeholder };
      }
      return part;
    }

    // E. Anthropic image blocks (type: "image")
    if (part.type === 'image' && part.source && typeof part.source.data === 'string') {
      const dataStr = part.source.data;
      const mediaType = part.source.media_type || 'image/png';

      if (!isRecent && !isInitial && dataStr.length > 512) {
        const capsuleId = getDeterministicCapsuleId(dataStr, 'jigit-img');
        saveCapsule(capsuleId, dataStr, {
          mimeType: mediaType,
          size: dataStr.length,
          type: 'image',
          category: 'Image',
          conversationId: options.conversationId || null,
        }, options);

        const sizeKb = (dataStr.length / 1024).toFixed(1);
        const placeholder = `[JIGIT Engine: Historical image (${mediaType}, ${sizeKb} KB) analyzed and archived to capsule ${capsuleId}. Use MCP tool jigit_restore_capsule('${capsuleId}') to inspect original image.]`;

        if (tracker) {
          tracker.recordItem({
            type: 'Historical Image',
            name: mediaType,
            originalSize: dataStr.length,
            compactedSize: placeholder.length,
            capsuleId,
            details: `${sizeKb} KB`,
          });
        }

        return { type: 'text', text: placeholder };
      }
      return part;
    }

    return part;
  });

  return { ...turn, parts: optimizedParts };
}

/**
 * JIGIT Engine Pipeline:
 * - Preserves Turn Structure & Schema Validity (alternating user/model roles, functionCall/functionResponse pairing)
 * - Preserves Initial Task Intent (Turn 0)
 * - Preserves Full Granularity on Recent Turns (keepRecentTurns, default 8)
 * - Offloads historical tool outputs, image base64, and compiler logs to JIGIT Capsule Store
 * - Instruments with detailed compression metrics via jigit-logger
 */
function runJigitPipeline(turnsList, options = {}) {
  if (!Array.isArray(turnsList) || turnsList.length === 0) return [];
  const totalTurns = turnsList.length;
  const keepRecentTurns = options.keepRecentTurns || 8;

  const tracker = options.tracker || createCompressionTracker(options);
  const originalChars = JSON.stringify(turnsList).length;

  const optimized = turnsList.map((turn, index) => {
    const isRecent = index >= totalTurns - keepRecentTurns;
    const isInitial = index === 0;
    return optimizeTurnWithJigit(turn, isRecent, isInitial, { ...options, tracker });
  });

  const optimizedChars = JSON.stringify(optimized).length;
  tracker.finalize(originalChars, optimizedChars);

  if (!options.silent) {
    logCompressionSummary(tracker);
  }

  optimized._compressionTracker = tracker;
  return optimized;
}

/**
 * Fast-path prompt budget enforcer for standalone prompt strings
 */
function enforceJigitBudget(promptText, maxChars = 60000) {
  if (typeof promptText !== 'string' || promptText.length <= maxChars) {
    return promptText;
  }
  const headSize = Math.floor(maxChars * 0.4);
  const tailSize = Math.floor(maxChars * 0.5);
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
  optimizeTurnWithJigit,
};
