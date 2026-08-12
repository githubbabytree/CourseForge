export type SupportedTransition = "none" | "fade" | "slide" | "convex" | "concave" | "zoom";
export interface RenderSegmentInput { readonly slideId:string;readonly order:number;readonly durationMs:number;readonly audioUri?:string;readonly transition:SupportedTransition;readonly sourceHash:string }
export interface RenderManifestInput { readonly schemaVersion:"1";readonly renderId:string;readonly width:number;readonly height:number;readonly fps:number;readonly output:{readonly container:string;readonly videoCodec:string;readonly pixelFormat:string;readonly audioCodec:string};readonly segments:readonly RenderSegmentInput[] }
export interface SpeechManifestInput { readonly totalDurationMs?:number;readonly totalMeasuredDurationMs?:number;readonly sentences:readonly {readonly startsAtMs:number;readonly endsAtMs:number}[] }
export type FinalTransitionKind = "fade" | "slideleft";
export interface VideoTimelineSegment { readonly slideId:string;readonly order:number;readonly startsAtMs:number;readonly endsAtMs:number;readonly durationMs:number;readonly measuredDurationMs:number;readonly firstFrame:number;readonly frameCount:number }
export interface VideoTimelineTransition { readonly schemaVersion:"1";readonly boundaryOrder:number;readonly fromSlideId:string;readonly toSlideId:string;readonly kind:FinalTransitionKind;readonly startsAtMs:number;readonly endsAtMs:number;readonly durationMs:number;readonly firstFrame:number;readonly frameCount:number }
export interface VideoTimeline { readonly schemaVersion:"2";readonly renderMode:"final-static-xfade-v1";readonly transitionPolicyVersion:"xfade-v1";readonly width:1920;readonly height:1080;readonly fps:30;readonly speechDurationMs:number;readonly totalDurationMs:number;readonly totalFrames:number;readonly segments:readonly VideoTimelineSegment[];readonly transitions:readonly VideoTimelineTransition[] }
const safeId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const finalTransitionKind=(value:SupportedTransition):FinalTransitionKind|undefined=>{
  if(value==="none")return undefined;if(value==="fade"||value==="convex"||value==="concave"||value==="zoom")return "fade";if(value==="slide")return "slideleft";
  throw new Error("final render transition is outside the fixed xfade allowlist");
};

export function buildVideoTimeline(render:RenderManifestInput,speech:SpeechManifestInput,transitionMs=300):VideoTimeline{
  if(render.width!==1920||render.height!==1080||render.fps!==30||render.output.container!=="mp4"||render.output.videoCodec!=="h264"||render.output.audioCodec!=="aac"||render.output.pixelFormat!=="yuv420p")throw new Error("render manifest must target 1920x1080 H264/AAC MP4 at 30 fps yuv420p");
  if(!Number.isSafeInteger(transitionMs)||transitionMs<250||transitionMs>500)throw new RangeError("transition duration must be 250-500 ms");
  let speechCursor=0,frameCursor=0;
  const segments=render.segments.map((segment,index):VideoTimelineSegment=>{
    if(segment.order!==index||!safeId.test(segment.slideId)||!Number.isSafeInteger(segment.durationMs)||segment.durationMs<250)throw new Error("render segments must be contiguous, safe, and at least 250 ms");
    // Each page owns a whole number of frames. Ceil per page (rather than rounding
    // cumulative milliseconds) guarantees the video slot is never shorter than its
    // measured narration, so FFmpeg only pads silence and never cuts the spoken tail.
    const frameCount=Math.ceil(segment.durationMs*30/1000),frameEnd=frameCursor+frameCount;
    if(frameCount<1)throw new Error("render segment has no video frame");
    const startsAtMs=frameCursor*1000/30,endsAtMs=frameEnd*1000/30,durationMs=frameCount*1000/30;
    const result={slideId:segment.slideId,order:index,startsAtMs,endsAtMs,durationMs,measuredDurationMs:segment.durationMs,firstFrame:frameCursor,frameCount};
    speechCursor+=segment.durationMs;frameCursor=frameEnd;return result;
  });
  if(!segments.length)throw new Error("render manifest must contain at least one segment");
  const speechDuration=speech.totalMeasuredDurationMs??speech.totalDurationMs;
  if(typeof speechDuration!=="number"||!Number.isSafeInteger(speechDuration)||speechDuration<0)throw new Error("speech manifest duration is invalid");
  if(Math.abs(speechDuration-speechCursor)>20)throw new Error("render and speech manifest durations disagree");
  let sentenceCursor=0;for(const sentence of speech.sentences){if(sentence.startsAtMs!==sentenceCursor||sentence.endsAtMs<=sentence.startsAtMs)throw new Error("speech sentence timeline must be contiguous");sentenceCursor=sentence.endsAtMs;}if(sentenceCursor!==speechDuration)throw new Error("speech sentences do not equal manifest duration");
  const transitionFrames=Math.ceil(transitionMs*30/1000),durationMs=transitionFrames*1000/30;
  const transitions:VideoTimelineTransition[]=[];
  for(let index=1;index<segments.length;index+=1){
    // A slide's transition declares how it enters from its predecessor. The
    // transition occupies the first frames of the incoming page; narration
    // remains an independent, non-overlapped concat beginning at this boundary.
    const kind=finalTransitionKind(render.segments[index]!.transition);if(!kind)continue;
    const previous=segments[index-1]!,next=segments[index]!;
    if(previous.frameCount<transitionFrames||next.frameCount<transitionFrames)throw new Error("adjacent slide is too short for the requested final transition");
    transitions.push({schemaVersion:"1",boundaryOrder:index-1,fromSlideId:previous.slideId,toSlideId:next.slideId,kind,
      startsAtMs:next.firstFrame*1000/30,endsAtMs:(next.firstFrame+transitionFrames)*1000/30,durationMs,firstFrame:next.firstFrame,frameCount:transitionFrames});
  }
  return{schemaVersion:"2",renderMode:"final-static-xfade-v1",transitionPolicyVersion:"xfade-v1",width:1920,height:1080,fps:30,speechDurationMs:speechCursor,totalDurationMs:frameCursor*1000/30,totalFrames:frameCursor,segments,transitions};
}

const safeFile=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|wav)$/u;
const safeOutput=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mp4$/u;
function controlledPath(value:string,extension:"png"|"wav"):string{if(!safeFile.test(value)||!value.endsWith(`.${extension}`)||value.includes(".."))throw new Error("media filename is outside the controlled work directory");return `work/${value}`;}
export interface FfmpegRenderPlan { readonly executable:"ffmpeg";readonly args:readonly string[];readonly outputPath:string;readonly filterComplex:string;readonly timeline:VideoTimeline }
export function createFfmpegRenderPlan(input:{render:RenderManifestInput;speech:SpeechManifestInput;slideImages:Readonly<Record<string,string>>;slideAudio:Readonly<Record<string,string>>;outputFilename:string;transitionDurationMs?:number}):FfmpegRenderPlan{
  const timeline=buildVideoTimeline(input.render,input.speech,input.transitionDurationMs??300);if(!safeOutput.test(input.outputFilename)||input.outputFilename.includes(".."))throw new Error("output filename is unsafe");
  const args:string[]=["-hide_banner","-nostdin","-y"];const filters:string[]=[];
  for(const segment of timeline.segments){const image=controlledPath(input.slideImages[segment.slideId]??"","png"),audio=controlledPath(input.slideAudio[segment.slideId]??"","wav"),seconds=(segment.frameCount/30).toFixed(9),index=segment.order*2;args.push("-loop","1","-framerate","30","-i",image,"-i",audio);const outgoing=timeline.transitions.find(item=>item.boundaryOrder===segment.order)?.frameCount??0;filters.push(`[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fps=30,trim=end_frame=${segment.frameCount+outgoing},settb=AVTB,setpts=PTS-STARTPTS[v${segment.order}]`);filters.push(`[${index+1}:a]apad=whole_dur=${seconds},atrim=end=${seconds},asetpts=PTS-STARTPTS[a${segment.order}]`);}
  let videoLabel="v0";
  for(let index=1;index<timeline.segments.length;index+=1){const transition=timeline.transitions.find(item=>item.boundaryOrder===index-1),output=`vx${index}`;if(transition){filters.push(`[${videoLabel}][v${index}]xfade=transition=${transition.kind}:duration=${(transition.frameCount/30).toFixed(9)}:offset=${(transition.firstFrame/30).toFixed(9)}[${output}]`);}else{filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0[${output}]`);}videoLabel=output;}
  filters.push(`[${videoLabel}]trim=end_frame=${timeline.totalFrames},setpts=PTS-STARTPTS[vout]`);
  filters.push(`${timeline.segments.map(s=>`[a${s.order}]`).join("")}concat=n=${timeline.segments.length}:v=0:a=1[aout]`);const filterComplex=filters.join(";");args.push("-filter_complex",filterComplex,"-map","[vout]","-map","[aout]","-c:v","libx264","-pix_fmt","yuv420p","-r","30","-fps_mode","cfr","-frames:v",String(timeline.totalFrames),"-c:a","aac","-movflags","+faststart","-f","mp4",`work/${input.outputFilename}`);return{executable:"ffmpeg",args,outputPath:`work/${input.outputFilename}`,filterComplex,timeline};
}

export interface Mp4ProbeMetadata {readonly durationMs:number;readonly frameCount:number;readonly video:{readonly codec:string;readonly width:number;readonly height:number;readonly fps:number;readonly pixelFormat:string};readonly audio:{readonly codec:string;readonly sampleRateHz:number;readonly channels:number}}
function boxType(bytes:Uint8Array,offset:number):string{return String.fromCharCode(...bytes.subarray(offset+4,offset+8));}
export function validateMp4Artifact(bytes:Uint8Array,probe:Mp4ProbeMetadata,expectedFrameCount:number):void{
  if(bytes.byteLength<24)throw new Error("MP4 is too small");let cursor=0;const boxes=new Set<string>();
  while(cursor+8<=bytes.byteLength){const view=new DataView(bytes.buffer,bytes.byteOffset+cursor,bytes.byteLength-cursor),size=view.getUint32(0,false),type=boxType(bytes,cursor);if(size===0){boxes.add(type);cursor=bytes.byteLength;break;}if(size===1||size<8||cursor+size>bytes.byteLength)throw new Error("MP4 contains an invalid ISO BMFF box");boxes.add(type);cursor+=size;}
  if(cursor!==bytes.byteLength||!boxes.has("ftyp")||!boxes.has("moov")||!boxes.has("mdat"))throw new Error("MP4 required ISO BMFF boxes are missing");
  if(probe.video.codec!=="h264"||probe.audio.codec!=="aac"||probe.video.width!==1920||probe.video.height!==1080||probe.video.fps!==30||probe.video.pixelFormat!=="yuv420p")throw new Error("MP4 probe metadata does not match the delivery profile");
  if(!Number.isSafeInteger(probe.audio.sampleRateHz)||probe.audio.sampleRateHz<8000||probe.audio.sampleRateHz>192000||![1,2].includes(probe.audio.channels))throw new Error("MP4 AAC metadata is invalid");
  if(!Number.isSafeInteger(expectedFrameCount)||expectedFrameCount<=0||probe.frameCount!==expectedFrameCount)throw new Error("MP4 frame count does not match the render timeline");
  const expectedDurationMs=expectedFrameCount*1000/30;
  if(!Number.isSafeInteger(probe.durationMs)||Math.abs(probe.durationMs-expectedDurationMs)>1000/30)throw new Error("MP4 duration does not match the quantized render timeline");
}
