import { createHash } from "node:crypto";

export const MEDIA_ORCHESTRATION_VERSION = "sentence-audio-v1" as const;
export const AUDIO_MASTERING_TARGET = Object.freeze({ integratedLufs: -16, maxTruePeakDbtp: -1, description: "Normalize the completed spoken-word program to -16 LUFS integrated and keep true peak at or below -1 dBTP. Loudness and true peak require a compliant measurement/render engine; WAV header validation alone does not claim them." });
export interface NarrationSentence { readonly sentenceId: string; readonly order: number; readonly text: string; readonly targetDurationMs: number }
const closers = new Set(["”", "’", "\"", "'", "）", ")", "】", "]", "》", "〉"]);
const boundaries = new Set(["。", "！", "？", "!", "?", "；", ";"]);

export function segmentChineseNarration(script: string): string[] {
  const normalized = script.replace(/\r\n?/gu, "\n").replace(/[\t\f\v ]+/gu, " ").trim();
  if (!normalized) return [];
  const result: string[] = []; let buffer = "";
  const push = () => { const value = buffer.trim(); if (value) result.push(value); buffer = ""; };
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "\n") { push(); while (normalized[index + 1] === "\n") index += 1; continue; }
    buffer += character;
    const ellipsis = character === "…" && normalized[index + 1] === "…";
    if (ellipsis) buffer += normalized[++index]!;
    if (boundaries.has(character) || ellipsis) { while (closers.has(normalized[index + 1] ?? "")) buffer += normalized[++index]!; push(); }
  }
  push(); return result;
}
const speechWeight = (text: string) => Math.max(1, [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length + [...text].filter((c) => "，,、：:".includes(c)).length * .35 + [...text].filter((c) => "。！？!?；;……".includes(c)).length * .7);
export function allocateSentenceTargets(script: string, totalTargetMs: number): NarrationSentence[] {
  if (!Number.isSafeInteger(totalTargetMs) || totalTargetMs < 250) throw new RangeError("totalTargetMs must be an integer of at least 250 ms");
  const texts = segmentChineseNarration(script); if (!texts.length) throw new Error("narration must contain at least one sentence");
  if (totalTargetMs < texts.length * 250) throw new RangeError("target duration must allow at least 250 ms per sentence");
  const remainderPool = totalTargetMs - texts.length * 250; const weights = texts.map(speechWeight); const total = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => remainderPool * w / total); const allocated = exact.map(Math.floor); let remainder = remainderPool - allocated.reduce((a, b) => a + b, 0);
  for (const item of exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index)) { if (remainder-- <= 0) break; allocated[item.index]! += 1; }
  return texts.map((text, order) => ({ sentenceId: `sentence-${createHash("sha256").update(`${order}\u0000${text}`).digest("hex").slice(0, 16)}`, order, text, targetDurationMs: allocated[order]! + 250 }));
}

export interface MeasuredSentenceAudio { readonly sentenceId: string; readonly uri: string; readonly durationMs: number; readonly contentHash: string }
export interface TimedSentence extends NarrationSentence { readonly startsAtMs: number; readonly endsAtMs: number; readonly measuredDurationMs: number; readonly audioUri: string; readonly audioContentHash: string }
export interface MeasuredDurationManifest { readonly schemaVersion: "1"; readonly orchestrationVersion: typeof MEDIA_ORCHESTRATION_VERSION; readonly totalTargetDurationMs: number; readonly totalMeasuredDurationMs: number; readonly sentences: readonly TimedSentence[] }
export function buildMeasuredDurationManifest(sentences: readonly NarrationSentence[], audio: readonly MeasuredSentenceAudio[]): MeasuredDurationManifest {
  if (!sentences.length || audio.length !== sentences.length) throw new Error("measured audio must match every sentence exactly");
  const byId = new Map(audio.map((item) => [item.sentenceId, item])); if (byId.size !== audio.length) throw new Error("measured audio sentence ids must be unique"); let cursor = 0;
  const timed = sentences.map((sentence, index): TimedSentence => { if (sentence.order !== index) throw new Error("sentence order must be contiguous"); const measured = byId.get(sentence.sentenceId); if (!measured || !Number.isSafeInteger(measured.durationMs) || measured.durationMs <= 0 || !measured.uri || !/^[a-f0-9]{64}$/u.test(measured.contentHash)) throw new Error("measured audio metadata is incomplete"); const startsAtMs = cursor; cursor += measured.durationMs; return { ...sentence, startsAtMs, endsAtMs: cursor, measuredDurationMs: measured.durationMs, audioUri: measured.uri, audioContentHash: measured.contentHash }; });
  if ([...byId.keys()].some((id) => !sentences.some((s) => s.sentenceId === id))) throw new Error("measured audio contains an unknown sentence id");
  return { schemaVersion: "1", orchestrationVersion: MEDIA_ORCHESTRATION_VERSION, totalTargetDurationMs: sentences.reduce((sum, item) => sum + item.targetDurationMs, 0), totalMeasuredDurationMs: cursor, sentences: timed };
}
function subtitleTime(ms: number, separator: "." | ","): string { if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("subtitle time must be a non-negative integer"); const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000); return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}${separator}${String(ms % 1000).padStart(3,"0")}`; }
const subtitleText = (text: string) => text.replace(/-->/gu, "→").replace(/\r\n?/gu, "\n").trim();
export const renderWebVtt = (manifest: MeasuredDurationManifest): string => `WEBVTT\n\n${manifest.sentences.map((s) => `${subtitleTime(s.startsAtMs,".")} --> ${subtitleTime(s.endsAtMs,".")}\n${subtitleText(s.text)}`).join("\n\n")}\n`;
export const renderSrt = (manifest: MeasuredDurationManifest): string => `${manifest.sentences.map((s,i) => `${i+1}\n${subtitleTime(s.startsAtMs,",")} --> ${subtitleTime(s.endsAtMs,",")}\n${subtitleText(s.text)}`).join("\n\n")}\n`;

export type DurationCorrectionAction = "accept"|"pad_silence"|"atempo"|"tts_speed"|"rewrite";
export interface DurationCorrectionDecision { readonly action: DurationCorrectionAction; readonly targetDurationMs: number; readonly measuredDurationMs: number; readonly deviationRatio: number; readonly speed?: number; readonly silencePaddingMs?: number; readonly rewriteHint?: string }
export function decideDurationCorrection(targetDurationMs: number, measuredDurationMs: number): DurationCorrectionDecision {
  if (!Number.isSafeInteger(targetDurationMs)||targetDurationMs<=0||!Number.isSafeInteger(measuredDurationMs)||measuredDurationMs<=0) throw new RangeError("durations must be positive integer milliseconds");
  const deviationRatio=(measuredDurationMs-targetDurationMs)/targetDurationMs, absolute=Math.abs(deviationRatio), base={targetDurationMs,measuredDurationMs,deviationRatio};
  if(absolute<=.01)return{...base,action:"accept"}; const rewriteHint=measuredDurationMs>targetDurationMs?"优先压缩讲稿，删除重复表达并保留事实与行动要求。":"优先补充讲稿，增加解释或示例，不用无意义停顿凑时长。";
  if(measuredDurationMs<targetDurationMs&&absolute<=.05)return{...base,action:"pad_silence",silencePaddingMs:targetDurationMs-measuredDurationMs,rewriteHint}; const speed=measuredDurationMs/targetDurationMs;
  if(absolute<=.05)return{...base,action:"atempo",speed,rewriteHint}; if(speed>=.90&&speed<=1.10)return{...base,action:"tts_speed",speed,rewriteHint}; return{...base,action:"rewrite",rewriteHint};
}

export interface WavMetadata { readonly format:"pcm"|"ieee-float";readonly channels:number;readonly sampleRateHz:number;readonly bitsPerSample:number;readonly blockAlign:number;readonly dataBytes:number;readonly sampleFrames:number;readonly durationMs:number }
export function inspectWav(bytes:Uint8Array):WavMetadata{
  if(bytes.byteLength<44)throw new Error("WAV is too small");const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),ascii=(o:number,l:number)=>String.fromCharCode(...bytes.subarray(o,o+l)),u16=(o:number)=>view.getUint16(o,true),u32=(o:number)=>view.getUint32(o,true);
  if(ascii(0,4)!=="RIFF"||ascii(8,4)!=="WAVE"||u32(4)+8>bytes.byteLength)throw new Error("WAV RIFF header is invalid");let cursor=12,format:{code:number;channels:number;rate:number;byteRate:number;align:number;bits:number}|undefined,dataBytes:number|undefined;
  while(cursor+8<=bytes.byteLength){const id=ascii(cursor,4),size=u32(cursor+4),start=cursor+8,end=start+size;if(end>bytes.byteLength)throw new Error("WAV chunk is truncated");if(id==="fmt "){if(size<16)throw new Error("WAV fmt chunk is invalid");format={code:u16(start),channels:u16(start+2),rate:u32(start+4),byteRate:u32(start+8),align:u16(start+12),bits:u16(start+14)};}else if(id==="data"){if(dataBytes!==undefined)throw new Error("WAV contains multiple data chunks");dataBytes=size;}cursor=end+(size%2);}
  if(!format||dataBytes===undefined||(format.code!==1&&format.code!==3))throw new Error("WAV must contain PCM or IEEE float fmt and data chunks");if(format.channels<1||format.channels>8||format.rate<8000||format.rate>192000||![8,16,24,32,64].includes(format.bits))throw new Error("WAV audio format is outside supported limits");const expectedAlign=format.channels*format.bits/8;if(!Number.isInteger(expectedAlign)||format.align!==expectedAlign||format.byteRate!==format.rate*format.align||dataBytes%format.align!==0)throw new Error("WAV rate, alignment, or data length is inconsistent");const sampleFrames=dataBytes/format.align;return{format:format.code===1?"pcm":"ieee-float",channels:format.channels,sampleRateHz:format.rate,bitsPerSample:format.bits,blockAlign:format.align,dataBytes,sampleFrames,durationMs:Math.round(sampleFrames/format.rate*1000)};
}
export function validateMeasuredWavDuration(bytes:Uint8Array,declaredDurationMs:number,toleranceMs=20):WavMetadata{if(!Number.isSafeInteger(declaredDurationMs)||declaredDurationMs<=0||!Number.isSafeInteger(toleranceMs)||toleranceMs<0)throw new RangeError("declared duration and tolerance are invalid");const metadata=inspectWav(bytes);if(Math.abs(metadata.durationMs-declaredDurationMs)>toleranceMs)throw new Error("WAV measured duration does not match its manifest");return metadata;}

interface Pcm16Wav { metadata: WavMetadata; samples: Uint8Array }
function parsePcm16Wav(bytes: Uint8Array): Pcm16Wav {
  const metadata = inspectWav(bytes);
  if (metadata.format !== "pcm" || metadata.bitsPerSample !== 16) throw new Error("WAV concatenation requires PCM 16-bit little-endian audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error("WAV RIFF length must match the complete input");
  let cursor = 12; let data: Uint8Array | undefined;
  while (cursor + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
    const size = view.getUint32(cursor + 4, true); const start = cursor + 8; const end = start + size;
    if (end > bytes.byteLength) throw new Error("WAV chunk is truncated");
    if (id === "data") data = bytes.subarray(start, end);
    cursor = end + size % 2;
  }
  if (!data || data.byteLength !== metadata.dataBytes) throw new Error("WAV data chunk is missing or inconsistent");
  return { metadata, samples: data };
}

/** Concatenates compatible PCM16 WAV buffers without resampling and writes a fresh canonical header. */
export function concatenatePcm16Wav(inputs: readonly Uint8Array[]): { readonly bytes: Uint8Array; readonly metadata: WavMetadata } {
  if (inputs.length === 0) throw new Error("at least one WAV input is required");
  const parsed = inputs.map(parsePcm16Wav); const first = parsed[0]!.metadata;
  if (parsed.some(({ metadata }) => metadata.sampleRateHz !== first.sampleRateHz || metadata.channels !== first.channels || metadata.blockAlign !== first.blockAlign)) throw new Error("WAV inputs require identical sample rate and channels; resampling is not performed");
  const dataBytes = parsed.reduce((sum, item) => sum + item.samples.byteLength, 0);
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffffffff - 36) throw new Error("concatenated WAV exceeds RIFF size limits");
  const output = new Uint8Array(44 + dataBytes); const view = new DataView(output.buffer);
  const writeAscii = (offset: number, value: string) => { for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index); };
  writeAscii(0,"RIFF");view.setUint32(4,36+dataBytes,true);writeAscii(8,"WAVE");writeAscii(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,first.channels,true);view.setUint32(24,first.sampleRateHz,true);view.setUint32(28,first.sampleRateHz*first.blockAlign,true);view.setUint16(32,first.blockAlign,true);view.setUint16(34,16,true);writeAscii(36,"data");view.setUint32(40,dataBytes,true);
  let offset=44;for(const item of parsed){output.set(item.samples,offset);offset+=item.samples.byteLength;}
  return { bytes: output, metadata: inspectWav(output) };
}
export * from "./video.js";
