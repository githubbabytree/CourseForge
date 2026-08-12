"use client";

import { useEffect, useState } from "react";
import type { CourseClient, GenerationJob, JobEvent, PublishedCourseRecord, QaReport } from "../lib/course-client";
import { formatShanghaiDateTime } from "../lib/time.mjs";

const approvals = [
  { type: "blind-listening" as const, label: "中文盲听" },
  { type: "target-cpu-benchmark" as const, label: "目标 CPU 基准" },
  { type: "copyright-review" as const, label: "版权复核" },
];

type ApprovalType = typeof approvals[number]["type"];

export function QaPublicationPanel({ client, projectId, deckArtifactId, speechManifestArtifactId, videoManifestArtifactId }: {
  client: CourseClient; projectId: string; deckArtifactId: string; speechManifestArtifactId: string; videoManifestArtifactId: string;
}) {
  const [report, setReport] = useState<QaReport>();
  const [courses, setCourses] = useState<PublishedCourseRecord[]>([]);
  const [approvalType, setApprovalType] = useState<ApprovalType>();
  const [evidenceArtifactId, setEvidenceArtifactId] = useState("");
  const [evidenceSha256, setEvidenceSha256] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [releaseJob,setReleaseJob]=useState<GenerationJob>();
  const [releaseEvents,setReleaseEvents]=useState<JobEvent[]>([]);
  const [releaseCourseId,setReleaseCourseId]=useState("");
  const [releaseReady,setReleaseReady]=useState<Record<string,"checking"|"ready"|"pending"|"error">>({});

  const refreshCourses=async()=>{const records=await client.listPublishedCourses(projectId);setCourses(records);const active=records.filter(record=>record.status==="published");setReleaseReady(current=>({...current,...Object.fromEntries(active.map(record=>[record.course.publishedCourseId,"checking"]))}));const checks=await Promise.all(active.map(async record=>[record.course.publishedCourseId,await client.isPublishedReleaseReady(projectId,record.course.publishedCourseId)?"ready":"pending"] as const));setReleaseReady(current=>({...current,...Object.fromEntries(checks)}));};
  useEffect(() => { let active=true;void refreshCourses().catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"发布历史读取失败");});return()=>{active=false;}; }, [client, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(!releaseJob?.jobId)return;return client.watchJob(releaseJob.jobId,(job,events)=>{setReleaseJob(job);setReleaseEvents(current=>[...current,...events]);if(job.status==="completed"){void refreshCourses().catch(reason=>setError(reason instanceof Error?reason.message:"发布完成，但下载状态刷新失败"));}else if(job.status==="failed"||job.status==="cancelled"){const detail=[...releaseEvents,...events].at(-1)?.message;setError(detail||`发布包任务${job.status==="failed"?"失败":"已取消"}`);}},reason=>setError(reason.message));},[client,releaseJob?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    setBusy(true); setError("");
    try { setReport(await client.runCourseQa(projectId, { deckArtifactId, speechManifestArtifactId, videoManifestArtifactId })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "QA失败"); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!report || !approvalType) return;
    setBusy(true); setError("");
    try {
      await client.approveCourseQa(projectId, { qaReportArtifactId: report.artifactId, type: approvalType, evidenceArtifactId, evidenceSha256, note });
      setApprovalType(undefined); setEvidenceArtifactId(""); setEvidenceSha256(""); setNote("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "审批记录失败"); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!report) return;
    setBusy(true); setError("");
    try { const result=await client.publishCourse(projectId, report.artifactId);setReleaseCourseId(result.course.publishedCourseId);setReleaseReady(current=>({...current,[result.course.publishedCourseId]:"pending"}));setReleaseEvents([]);if(result.job)setReleaseJob(result.job);else{setReleaseJob(undefined);await refreshCourses();} }
    catch (reason) { setError(reason instanceof Error ? reason.message : "发布被阻止"); }
    finally { setBusy(false); }
  };
  const withdraw=async(record:PublishedCourseRecord)=>{const reason=window.prompt("请输入撤回原因（至少 4 个字符）。撤回不会删除历史记录。","");if(!reason)return;setBusy(true);setError("");try{await client.withdrawPublishedCourse(projectId,record.course.publishedCourseId,reason);setCourses(await client.listPublishedCourses(projectId));}catch(reason){setError(reason instanceof Error?reason.message:"撤回失败");}finally{setBusy(false);}};

  return <section className="qa-publication">
    <header><div><b>课程 QA 与发布</b><small>机器检查不能替代人工盲听、目标 CPU 基准和版权审批。</small></div><button className="secondary" onClick={() => void run()} disabled={busy}>{busy ? "处理中…" : "运行机器 QA"}</button></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {report && <>
      <div className="qa-summary"><b>{report.blockerCount} 个阻断项</b><span>{report.warningCount} 个警告</span><time>{formatShanghaiDateTime(report.createdAt)}</time></div>
      <ul>{report.checks.map((check) => <li key={check.checkId} className={check.status}><b>{check.checkId}</b><span>{check.message}</span></li>)}</ul>
      <div className="qa-actions">{approvals.map((item) => <button className="secondary" key={item.type} onClick={() => setApprovalType(item.type)} disabled={busy}>{item.label}证据</button>)}<button className="primary" onClick={() => void publish()} disabled={busy || report.blockerCount > 0 || !!releaseJob&&!(["completed","failed","cancelled"] as string[]).includes(releaseJob.status)}>发布课程</button></div>
    </>}
    {releaseJob&&<div className={`release-progress ${releaseJob.status}`} role={releaseJob.status==="failed"?"alert":"status"}><div><b>发布包任务 · {releaseJob.status}</b><span>{releaseJob.progressPercent}% · 已进行 {Math.round(Math.max(0,...releaseEvents.map(event=>event.elapsedMs))/1000)} 秒</span></div><progress max="100" value={releaseJob.progressPercent}>{releaseJob.progressPercent}%</progress><small>Job {releaseJob.jobId} · 阶段 {releaseJob.stage}</small>{releaseEvents.at(-1)&&<p>{releaseEvents.at(-1)!.message}</p>}</div>}
    {approvalType && <form className="qa-evidence-form" onSubmit={(event) => { event.preventDefault(); void approve(); }}>
      <header><div><b>{approvals.find((item) => item.type === approvalType)?.label}证据</b><small>证据必须是当前项目中已持久化且哈希匹配的 Artifact。</small></div><button type="button" onClick={() => setApprovalType(undefined)}>关闭</button></header>
      <label>证据 Artifact ID<input required pattern="artifact-[a-f0-9]{64}" value={evidenceArtifactId} onChange={(event) => setEvidenceArtifactId(event.target.value.trim())}/></label>
      <label>内容 SHA-256<input required pattern="[a-f0-9]{64}" value={evidenceSha256} onChange={(event) => setEvidenceSha256(event.target.value.trim())}/></label>
      <label>人工核验说明<textarea required minLength={4} maxLength={2_000} rows={4} value={note} onChange={(event) => setNote(event.target.value)}/></label>
      <button className="primary" disabled={busy}>保存不可变审批记录</button>
    </form>}
    {courses.length > 0 && <div className="publication-history"><b>不可变发布历史</b>{courses.map((record) => {const readiness=releaseReady[record.course.publishedCourseId]??"checking";const ready=record.status==="published"&&readiness==="ready";return <span key={record.course.publishedCourseId}>r{record.course.revision} · {formatShanghaiDateTime(record.course.publishedAt)} · {record.status==="withdrawn"?<>已撤回（{formatShanghaiDateTime(record.withdrawal!.withdrawnAt)}）</>:<>{ready?<><a href={client.getPublishedCourseDownloadUrl(projectId,record.course.publishedCourseId,"webppt")}>WebPPT ZIP</a> · <a href={client.getPublishedCourseDownloadUrl(projectId,record.course.publishedCourseId,"video")}>MP4</a> · <a href={client.getPublishedCourseDownloadUrl(projectId,record.course.publishedCourseId,"vtt")}>VTT</a> · <a href={client.getPublishedCourseDownloadUrl(projectId,record.course.publishedCourseId,"srt")}>SRT</a> · <a href={client.getPublishedCourseDownloadUrl(projectId,record.course.publishedCourseId,"manifest")}>Manifest</a></>:<><span className="release-link-disabled" aria-disabled="true">下载未就绪（{readiness==="checking"?"核验中":"发布包生成中或不可用"}）</span>{record.course.publishedCourseId===releaseCourseId&&releaseJob&&<small>等待任务达到 100% 后自动刷新</small>}</>}<button className="secondary" disabled={busy} onClick={()=>void withdraw(record)}>撤回</button></>}</span>;})}</div>}
  </section>;
}
