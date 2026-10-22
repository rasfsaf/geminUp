const { parseGoogleFrames, parseGeminiStream } = require('../src/argon/stream-parser');

const text = 'легитимен полностью и адекватен 2';
const framePayload = JSON.stringify([null, null, JSON.stringify([null, null, null, null, [[null, [text]]]])]);
const wire = Buffer.concat([
  Buffer.from(")]}'\n"),
  Buffer.from(Buffer.byteLength(framePayload) + '\n'),
  Buffer.from(framePayload, 'utf8'),
]);

const res = parseGoogleFrames(wire);
console.log('Result frames count:', res.frames.length);
const parsed = parseGeminiStream(res.frames);
console.log('Extracted content:', parsed.content);
