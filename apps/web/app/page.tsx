"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiBaseUrl,
  demoCourseClient,
  onlineCourseClient,
  type AuthUser,
  type CourseBriefInput,
  type CourseClient,
  type CourseArtifact,
  type ArtifactPreviewSource,
  type CourseProject,
  type GenerationJob,
  type JobEvent,
  type ImageAsset,
  type DesignPlan,
  type DesignTemplate,
  type SourceRevision,
  type SpeechManifest,
  type VideoRenderManifest,
} from "@/lib/course-client";
import { formatShanghaiDateTime } from "@/lib/time.mjs";
import { AdminConsole } from "./admin-console";
import { DeckRevisionEditor } from "./deck-revision-editor";
import { MaterialRevisionEditor } from "./material-revision-editor";
import { QaPublicationPanel } from "./qa-publication-panel";
import { ImageSearchPanel } from "./image-search-panel";

const steps = [
  ["01", "输入材料", "汇集点子与资料"],
  ["02", "数据策略", "先确认数据边界"],
  ["03", "培训 Brief", "定义目标与受众"],
  ["04", "研究补全", "检索与事实核验"],
  ["05", "基础材料", "构建课程底稿"],
  ["06", "设计方向", "选择视觉语言"],
  ["07", "WebPPT", "编辑与预览"],
  ["08", "讲稿与时长", "校准配音节奏"],
  ["09", "视频交付", "渲染与质量检查"],
] as const;

const stepProgress = [8, 18, 25, 40, 52, 61, 72, 88, 100];

type IconName = "spark" | "grid" | "folder" | "settings" | "bell" | "plus" | "arrow" | "clock" | "play" | "check" | "search" | "upload" | "wand" | "book" | "mic" | "video" | "more" | "chevron" | "shield" | "users" | "target" | "palette";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    spark: <><path d="m12 3-1.6 4.4L6 9l4.4 1.6L12 15l1.6-4.4L18 9l-4.4-1.6L12 3Z"/><path d="m5 15-.7 1.8L2.5 17.5l1.8.7L5 20l.7-1.8 1.8-.7-1.8-.7L5 15Z"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    folder: <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-10Z"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>, arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    play: <path d="m9 7 8 5-8 5V7Z"/>, check: <path d="m5 12 4 4L19 6"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 14v5h14v-5"/></>, wand: <><path d="m4 20 11-11 3 3L7 23Z"/><path d="m14 4 .5-2 .5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5Z"/></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2V5.5Z"/></>,
    mic: <><rect x="8" y="3" width="8" height="13" rx="4"/><path d="M5 12a7 7 0 0 0 14 0M12 19v3"/></>, video: <><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>, chevron: <path d="m9 18 6-6-6-6"/>, shield: <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></>, target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m15 9 6-6"/></>, palette: <><circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="9" r="1"/><path d="M17 15c0 1-1 2-2 2h-1c-1 0-2-1-2-2s1-2 2-2h3v2Z"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Logo() {
  return <div className="logo"><span className="logo-mark"><Icon name="spark" size={22}/></span><span>Course<span>Forge</span></span></div>;
}

function AppShell({ children, user, mode, active = "home", onHome, onAdmin, onLogout }: { children: React.ReactNode; user: AuthUser; mode: "online" | "demo"; active?: string; onHome?: () => void; onAdmin?: () => void; onLogout: () => void }) {
  return <div className="app-shell">
    <aside className="side-rail">
      <Logo />
      <nav aria-label="主要导航">
        <button className={active === "home" ? "active" : ""} onClick={onHome}><Icon name="grid"/><span>工作台</span></button>
        <button className={active === "projects" ? "active" : ""}><Icon name="folder"/><span>我的项目</span></button>
        <button><Icon name="book"/><span>模板中心</span></button>
        <div className="nav-gap" />
        {(user.role === "platform_admin" || user.role === "auditor") && <button className={active === "admin" ? "active" : ""} onClick={onAdmin}><Icon name="settings"/><span>系统设置</span></button>}
      </nav>
      <div className="rail-bottom">
        <div className="storage"><span>存储空间</span><small>容量与保留策略由管理员监控</small></div>
        <div className="user"><span className="avatar">{user.displayName.slice(0, 1)}</span><span><b>{user.displayName}</b><small>{mode === "demo" ? "演示模式" : user.role}</small></span><button className="user-logout" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="more"/></button></div>
      </div>
    </aside>
    <main>{children}</main>
  </div>;
}

function Dashboard({ client, user, onOpen, onAdmin, onLogout }: { client: CourseClient; user: AuthUser; onOpen: () => void; onAdmin: () => void; onLogout: () => void }) {
  const [projects, setProjects] = useState<CourseProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadProjects = () => { setLoading(true); setError(""); void client.listProjects().then(setProjects).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "项目读取失败")).finally(() => setLoading(false)); };
  const activeCount = projects.filter((project) => project.status !== "completed").length;
  const completedCount = projects.filter((project) => project.status === "completed").length;
  useEffect(loadProjects, [client]);
  return <AppShell active="home" user={user} mode={client.mode} onLogout={onLogout} onAdmin={onAdmin}>
    <header className="topbar"><span className={`connection-pill ${client.mode}`} role="status"><i/>{client.mode === "online" ? "内部 Alpha · API 已连接" : "离线演示 · 数据不会保存"}</span><div className="search"><Icon name="search"/><input aria-label="搜索" placeholder="搜索项目、培训材料或模板"/><kbd>⌘ K</kbd></div><button className="icon-button" aria-label="通知"><Icon name="bell"/><i /></button></header>
    <div className="dashboard">
      <section className="welcome">
        <div><span className="eyebrow">COURSEFORGE · INTERNAL ALPHA</span><h1>你好，{user.displayName}</h1><p>把安全知识，变成真正有人愿意看完的培训。</p></div>
        <button className="primary" onClick={onOpen}><Icon name="plus"/>创建新培训</button>
      </section>
      <section className="hero-card">
        <div className="hero-orb orb-one"/><div className="hero-orb orb-two"/>
        <div className="hero-copy"><span className="ai-pill"><Icon name="spark" size={14}/> AI 课程向导</span><h2>从一个想法，到一堂完整的课</h2><p>当前可安全导入 TXT、Markdown、PDF、DOCX 与 PPTX；TTS 与视频将在后续批次接入。</p><button onClick={onOpen}>开始创作 <Icon name="arrow"/></button></div>
        <div className="hero-visual" aria-hidden="true"><div className="mini-deck"><span className="mini-top"><i/><i/><i/></span><b>守住数据边界</b><small>从一次真实的误发事件开始</small><div className="signal"><em/><em/><em/><em/><em/></div></div><span className="float-tag one"><Icon name="wand"/> 流程演练</span><span className="float-tag two"><Icon name="video"/> 视频能力需配置验收</span></div>
      </section>
      <section className="stats-row">
        <div><span className="stat-icon green"><Icon name="folder"/></span><p><small>进行中的项目</small><b>{loading ? "–" : activeCount}</b><em>来自当前项目列表</em></p></div>
        <div><span className="stat-icon purple"><Icon name="video"/></span><p><small>已生成课程</small><b>{loading ? "–" : completedCount}</b><em>来自当前项目列表</em></p></div>
        <div><span className="stat-icon orange"><Icon name="clock"/></span><p><small>本月节省时间</small><b>–</b><em>等待统计服务</em></p></div>
        <div><span className="stat-icon blue"><Icon name="users"/></span><p><small>累计覆盖员工</small><b>–</b><em>等待学习数据接入</em></p></div>
      </section>
      <section className="projects-head"><div><h2>最近项目</h2><p>继续你的创作，或查看生成结果</p></div><button>查看全部 <Icon name="chevron"/></button></section>
      {loading && <div className="load-state" role="status">正在从 {client.mode === "online" ? "CourseForge API" : "演示数据"} 读取项目…</div>}
      {error && <div className="error-banner" role="alert"><span><b>项目加载失败</b>{error}</span><button className="secondary" onClick={loadProjects}>重试</button></div>}
      <section className="project-grid">
        {projects.map((p) => <button key={p.id} className="project-card" onClick={onOpen}>
          <div className={`cover ${p.accent}`}><span>SECURITY<br/>ACADEMY</span><Icon name={p.status === "completed" ? "play" : p.status === "editing" ? "book" : "spark"} size={34}/><small>CourseForge</small></div>
          <div className="project-info"><span className={`status ${p.status}`}>{p.status === "completed" ? "已完成" : p.status === "generating" ? "生成中" : "编辑中"}</span><h3>{p.title}</h3><p>{p.subtitle}</p>
            {p.status === "generating" && <div className="project-progress"><span><i style={{width:`${p.progress}%`}}/></span><small>{p.progress}% · {p.duration}</small></div>}
            <footer><span>{p.slides ? `${p.slides} 页` : "Brief"}</span><span>{p.updatedAt}</span></footer>
          </div>
        </button>)}
        <button className="new-card" onClick={onOpen}><span><Icon name="plus" size={24}/></span><b>创建新培训</b><small>从一个点子或已有材料开始</small></button>
      </section>
    </div>
  </AppShell>;
}

function ProgressHeader({ step, onExit, job, latestEvent, mode }: { step: number; onExit: () => void; job?: GenerationJob; latestEvent?: JobEvent; mode: "online" | "demo" }) {
  const percent = job?.progressPercent ?? stepProgress[step] ?? 0;
  const elapsed = latestEvent ? `${Math.floor(latestEvent.elapsedMs / 60000).toString().padStart(2, "0")}:${Math.floor(latestEvent.elapsedMs % 60000 / 1000).toString().padStart(2, "0")}` : "00:00";
  const eventTime = latestEvent?.occurredAt ?? job?.updatedAt;
  return <header className="wizard-top"><button className="back-link" onClick={onExit}><Icon name="chevron"/> 返回工作台</button><div className="wizard-title"><b>新建安全培训</b><span>{mode === "demo" ? "演示模式 · 不会保存到服务器" : "内部 Alpha · 已连接 API"}</span></div><div className="run-state" aria-live="polite"><span className="pulse"/><span><b>{percent}%</b><small>{job ? `${latestEvent?.message ?? "任务已启动"} · ${elapsed}${eventTime ? ` · ${formatShanghaiDateTime(eventTime)}` : ""}` : "等待提交 Brief"}</small></span><div className="ring" style={{"--progress":`${percent * 3.6}deg`} as React.CSSProperties}>{percent}</div></div></header>;
}

function StepNav({ step, setStep }: { step: number; setStep: (n: number) => void }) {
  return <aside className="step-nav"><div className="step-heading"><span>课程生成向导</span><b>9 个步骤</b></div><nav aria-label="课程生成步骤">{steps.map(([n, title, desc], index) => <button key={n} className={`${index === step ? "active" : ""} ${index < step ? "done" : ""}`} onClick={() => setStep(index)}><span className="step-num">{index < step ? <Icon name="check" size={14}/> : n}</span><span><b>{title}</b><small>{desc}</small></span>{index === step && <Icon name="chevron" size={15}/>}</button>)}</nav><div className="tip"><Icon name="spark"/><div><b>AI 小提示</b><p>信息越具体，生成的课程越贴近你的真实培训场景。</p></div></div></aside>;
}

function SectionTitle({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return <div className="section-title"><span>{eyebrow}</span><h1>{title}</h1><p>{desc}</p></div>;
}

function BriefStep({ client, idea, policy, onSubmit, pending, error, mode }: { client: CourseClient; idea:string; policy: import("@/lib/course-client").ProjectDataPolicy; onSubmit: (brief: CourseBriefInput, snapshotId?: string) => Promise<void>; pending: boolean; error: string; mode: "online" | "demo" }) {
  const [brief,setBrief]=useState<CourseBriefInput>({title:"",idea,audience:"大型互联网公司全体员工",durationMinutes:20,objectives:["识别信息安全风险"],background:""});const[snapshot,setSnapshot]=useState("");const[assistance,setAssistance]=useState<import("@/lib/course-client").BriefAssistance>();const[aiError,setAiError]=useState("");const[assisting,setAssisting]=useState(false);useEffect(()=>setBrief(v=>({...v,idea})),[idea]);const assist=()=>{setAssisting(true);setAiError("");void client.assistBrief({snapshotId:snapshot,idea:brief.idea,dataPolicy:policy,partial:brief}).then(setAssistance).catch(e=>setAiError(e instanceof Error?e.message:"AI 补全失败")).finally(()=>setAssisting(false))};
  return <div className="content-narrow"><SectionTitle eyebrow="STEP 03 · TRAINING BRIEF" title="先把这堂课说清楚" desc="AI 建议不会自动创建项目；选择并应用后仍需显式提交。"/><form className="brief-form" onSubmit={e=>{e.preventDefault();void onSubmit(brief,mode==="online"?snapshot:undefined).catch(()=>undefined)}}><div className="field full"><label>培训点子</label><textarea value={brief.idea} onChange={e=>setBrief({...brief,idea:e.target.value})}/></div>{mode==="online"&&<div className="field full"><label>运行配置快照 <em>必填</em></label><input value={snapshot} onChange={e=>setSnapshot(e.target.value)} required pattern="[0-9a-fA-F-]{36}" placeholder="Snapshot UUID"/><button type="button" className="secondary" disabled={!snapshot||!brief.idea||assisting} onClick={assist}>{assisting?"AI 补全中…":"生成 AI Brief 建议"}</button></div>}<div className="field full"><label>课程名称</label><input value={brief.title} required onChange={e=>setBrief({...brief,title:e.target.value})}/></div><div className="field"><label>受众</label><input value={brief.audience} onChange={e=>setBrief({...brief,audience:e.target.value})}/></div><div className="field"><label>时长（分钟）</label><input type="number" min="5" max="240" value={brief.durationMinutes} onChange={e=>setBrief({...brief,durationMinutes:Number(e.target.value)})}/></div><div className="field full"><label>培训目标（每行一项）</label><textarea value={brief.objectives.join("\n")} onChange={e=>setBrief({...brief,objectives:e.target.value.split("\n").filter(Boolean)})}/></div><div className="field full"><label>背景</label><textarea value={brief.background} onChange={e=>setBrief({...brief,background:e.target.value})}/></div>{assistance&&<div className="field full"><b>选择一个互斥建议并显式应用</b><div className="goals">{assistance.options.map(o=><button type="button" key={o.optionId} onClick={()=>setBrief({title:o.brief.title,idea:o.brief.idea,audience:o.brief.audience,durationMinutes:o.brief.durationMinutes,objectives:o.brief.objectives,background:o.brief.background})}><b>{o.label}</b><small>{o.description}</small></button>)}</div></div>}{(error||aiError)&&<div className="form-error"><b>无法继续</b><span>{error||aiError}</span></div>}<div className="form-actions"><span>{mode==="demo"?"Demo 不调用真实 AI":"将启动真实 content-generations"}</span><button className="primary" disabled={pending}>{pending?"正在创建…":"确认 Brief 并开始生成"}</button></div></form></div>;
}

function MaterialStep({ research = false, mode = "demo", client, projectId, artifacts=[] }: { research?: boolean; mode?: "online" | "demo";client?:CourseClient;projectId?:string;artifacts?:CourseArtifact[] }) {
  const kind=research?"research-json":"material-json";const artifact=artifacts.filter(a=>a.kind===kind).sort((a,b)=>b.revision-a.revision)[0];const[data,setData]=useState<Record<string,unknown>>(),[readError,setReadError]=useState("");useEffect(()=>{if(mode!=="online"||!client||!projectId||!artifact)return;void client.getArtifactContent(projectId,artifact.artifactId).then(text=>setData(JSON.parse(text) as Record<string,unknown>)).catch(e=>setReadError(e instanceof Error?e.message:"产物读取失败"))},[mode,client,projectId,artifact?.artifactId]);if(mode==="online")return <div className="content-wide"><SectionTitle eyebrow={research?"STEP 04 · RESEARCH":"STEP 05 · COURSE MATERIAL"} title={research?"真实研究产物":"真实基础材料"} desc="内容来自受鉴权、项目绑定的持久化 JSON 产物。"/>{!artifact&&<div className="load-state">等待 {kind} 生成；不会使用演示数据替代。</div>}{readError&&<div className="error-banner">{readError}</div>}{artifact&&data&&<div className="admin-card"><b>{String(data.title??(research?"研究结果":"基础材料"))}</b><p>Artifact {artifact.artifactId} · r{artifact.revision} · {formatShanghaiDateTime(artifact.createdAt)}</p><pre>{JSON.stringify(data,null,2)}</pre></div>}</div>;return <div className="content-wide"><SectionTitle eyebrow="DEMO" title="静态演示流程" desc="演示模式不代表服务器生成结果。"/></div>;
}

function MaterialEditor() {
  const chapters = ["01  为什么现在必须谈 AI 安全", "02  一次看似普通的提问", "03  数据边界：什么不能输入", "04  四步安全判断法", "05  高频办公场景实战", "06  总结与行动清单"];
  const [selected, setSelected] = useState(2);
  return <div className="material-editor"><aside><div><b>课程章节</b><button><Icon name="plus"/></button></div>{chapters.map((item,index)=><button key={item} className={selected===index?"active":""} onClick={()=>setSelected(index)}><span>{item}</span><small>{index===2?"4 个知识点":"3 个知识点"}</small></button>)}</aside><article><div className="editor-toolbar"><button>H2</button><button><b>B</b></button><button><i>I</i></button><span/><button><Icon name="wand"/> AI 优化</button></div><span className="chapter-tag">CHAPTER 03</span><h2 contentEditable suppressContentEditableWarning>数据边界：什么不能输入 AI</h2><p contentEditable suppressContentEditableWarning>判断是否可以把信息输入生成式 AI 工具，关键不在于“这段文字看起来是否敏感”，而在于它的<strong>分类等级、公开状态与使用授权</strong>。</p><div className="callout"><Icon name="shield"/><p><b>核心判断原则</b><br/>任何未公开、受访问控制或包含个人信息的数据，在未获得明确授权前，都不应输入外部 AI 服务。</p></div><h3>四类高风险信息</h3><div className="risk-grid"><div><span>01</span><b>未公开业务数据</b><small>经营数据、产品规划、内部分析</small></div><div><span>02</span><b>源代码与配置</b><small>内部代码、密钥、系统配置</small></div><div><span>03</span><b>用户与员工信息</b><small>账号、联系方式、行为数据</small></div><div><span>04</span><b>安全与漏洞信息</b><small>漏洞细节、处置记录、架构信息</small></div></div><footer><span><Icon name="check"/> 4 条内容均已关联来源</span><button><Icon name="spark"/> 让 AI 改写这一节</button></footer></article></div>;
}

function DesignStep({ client, projectId, artifacts, onArtifactsChanged }: { client: CourseClient; projectId?: string; artifacts:CourseArtifact[]; onArtifactsChanged:()=>void }) {
  const [choice,setChoice]=useState(""); const [plan,setPlan]=useState<DesignPlan>(); const[planArtifactId,setPlanArtifactId]=useState(""); const [snapshot,setSnapshot]=useState(""); const[duration,setDuration]=useState(30);const[templates,setTemplates]=useState<DesignTemplate[]>([]);const[templateId,setTemplateId]=useState("");const[busy,setBusy]=useState(false);const[designJob,setDesignJob]=useState<GenerationJob>();
  const [assets,setAssets]=useState<ImageAsset[]>([]); const [selected,setSelected]=useState(""); const [assetError,setAssetError]=useState(""); const [uploading,setUploading]=useState(false); const [license,setLicense]=useState<ImageAsset["licensing"]["status"]>("company-owned");
  useEffect(()=>{if(projectId&&client.mode==="online")void Promise.all([client.listImageAssets(projectId),client.listPublishedDesignTemplates()]).then(([a,t])=>{setAssets(a);setTemplates(t)}).catch((reason:unknown)=>setAssetError(reason instanceof Error?reason.message:"设计数据读取失败"));},[client,projectId]);
  const designs=[{name:"信号边界",tag:"编辑推荐",desc:"高对比黑绿视觉，强调风险信号与行动边界",style:"signal"},{name:"透明协议",tag:"清晰理性",desc:"网格化信息设计，适合制度与方法论讲解",style:"protocol"},{name:"故障现场",tag:"故事沉浸",desc:"以事件现场为线索，带来更强的叙事张力",style:"incident"}];
  const material=artifacts.find(a=>a.kind==="material-json");const brandAssetIds=selected?[selected]:[];
  if(client.mode==="demo")return <div className="content-wide"><SectionTitle eyebrow="STEP 06 · DEMO FIXTURE" title="演示设计方向" desc="以下为静态演示 fixture，不是 AI 或服务器生成结果。"/><div className="design-grid">{designs.map((d,index)=><div key={d.name} className="design-card"><div className={`design-preview ${d.style}`}/><div className="design-meta"><b>{d.name}</b><p>{d.desc}</p></div></div>)}</div></div>;
  const waitForJob=(started:GenerationJob)=>new Promise<GenerationJob>((resolve,reject)=>{setDesignJob(started);const stop=client.watchJob(started.jobId,(current)=>{setDesignJob(current);if(current.status==="completed"){stop();resolve(current);}else if(current.status==="failed"||current.status==="cancelled"){stop();reject(new Error(current.status==="cancelled"?"任务已取消":"后台任务失败"));}},error=>{stop();reject(error)});});
  const create=()=>{if(!projectId||!material)return;setBusy(true);setAssetError("");void client.createDesignPlan(projectId,{snapshotId:snapshot,materialArtifactId:material.artifactId,durationMinutes:duration,brandAssetIds}).then(waitForJob).then(async job=>{const artifact=(await client.listArtifacts(projectId)).find(item=>item.jobId===job.jobId&&item.kind==="design-plan");if(!artifact)throw new Error("设计方向产物尚不可用");setPlan(JSON.parse(await client.getArtifactContent(projectId,artifact.artifactId)) as DesignPlan);setPlanArtifactId(artifact.artifactId);setChoice("");onArtifactsChanged()}).catch(reason=>setAssetError(reason instanceof Error?reason.message:"设计方向生成失败")).finally(()=>setBusy(false))};
  const generate=()=>{if(!projectId||!plan||!planArtifactId)return;setBusy(true);setAssetError("");void client.generateSelectedDeck(projectId,{snapshotId:snapshot,planArtifactId,...(choice?{directionId:choice}:{}),...(templateId?{templateId}:{}),durationMinutes:duration,brandAssetIds}).then(waitForJob).then(()=>onArtifactsChanged()).catch(reason=>setAssetError(reason instanceof Error?reason.message:"Deck 生成失败")).finally(()=>setBusy(false))};
  return <div className="content-wide"><SectionTitle eyebrow="STEP 06 · ART DIRECTION" title="生成并选择真实设计方向" desc="方向由运行快照绑定的设计 Provider 生成；选择和模板版本会写入 Deck provenance。"/><section className="image-library"><label>运行快照 UUID<input value={snapshot} onChange={e=>setSnapshot(e.target.value)} placeholder="Snapshot UUID"/></label><label>课程时长（分钟）<input type="number" min="5" max="240" value={duration} onChange={e=>setDuration(Number(e.target.value))}/></label><button className="primary" disabled={busy||!material||!snapshot} onClick={create}>{busy?"处理中…":"生成真实设计方向"}</button>{!material&&<p>暂无真实 material-json 产物，请先完成材料生成。</p>}</section>{plan?<div className="design-grid">{plan.directions.map(direction=><button key={direction.directionId} onClick={()=>setChoice(direction.directionId)} className={`design-card ${choice===direction.directionId?"selected":""}`}><div className="design-meta"><b>{direction.name}</b><p>{direction.rationale}</p><small>{Object.entries(direction.themeTokens).map(([k,v])=>`${k}: ${v}`).join(" · ")}</small></div></button>)}</div>:<p>尚未生成真实方向，不显示占位推荐。</p>}<section className="image-library"><label>已发布模板版本<select value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">后台默认（记录为空）</option>{templates.map(t=><option key={t.templateId} value={t.templateId}>{t.name} · {t.version}</option>)}</select></label><div className="image-asset-grid">{assets.filter(a=>a.licensing.status!=="unknown").map(asset=><button key={asset.assetId} className={selected===asset.assetId?"selected":""} onClick={()=>setSelected(selected===asset.assetId?"":asset.assetId)}><img src={projectId?client.getImageAssetContentUrl(projectId,asset.assetId):""} alt={asset.displayName}/><span><b>{asset.displayName}</b><small>{asset.licensing.status}</small></span></button>)}</div><button className="primary" disabled={busy||!plan} onClick={generate}>{choice?"按选择生成 / 重新生成 Deck":"使用已记录默认方向生成 Deck"}</button><p>生成后 TTS / 视频会标记为 stale，需要显式重新生成。</p>{assetError&&<div className="error-banner">{assetError}</div>}</section></div>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "未知大小";
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

function describeSourceLocator(locator: SourceRevision["sections"][number]["locator"]) {
  if (locator.kind === "pdf" && locator.pageNumber) return `PDF 第 ${locator.pageNumber} 页`;
  if (locator.kind === "pptx" && locator.slideNumber) return `PPTX 第 ${locator.slideNumber} 页${locator.source === "notes" ? "备注" : "正文"}`;
  if (locator.kind === "docx" && locator.paragraphIndex !== undefined) return `DOCX 第 ${locator.paragraphIndex + 1} 段`;
  if (locator.startLine !== undefined && locator.endLine !== undefined) return `第 ${locator.startLine}–${locator.endLine} 行`;
  return `字符 ${locator.startOffset}–${locator.endOffset}`;
}

function hardenPreviewHtml(html: string) {
  const guard = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;min-height:100%;background:#10231d;color:#eef9f5;font-family:system-ui,sans-serif}.reveal,.slides,.slides>section{min-height:100vh}.slides>section{padding:7%;display:grid;align-content:center}.slides>section~section{display:none}.slides h2{font-size:clamp(2rem,6vw,5rem);color:#48e5ad}.slides p,.slides li{font-size:clamp(1rem,2vw,1.5rem);line-height:1.6}.notes,script{display:none!important}</style>`;
  return /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${guard}`) : `<!doctype html><html lang="zh-CN"><head>${guard}</head><body>${html}</body></html>`;
}

function ArtifactPreviewDialog({ artifact, source, mode, loading, error, onClose }: { artifact: CourseArtifact; source?: ArtifactPreviewSource; mode: "online" | "demo"; loading: boolean; error: string; onClose: () => void }) {
  const [frameLoaded, setFrameLoaded] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  useEffect(() => setFrameLoaded(false), [source]);
  return <div className="artifact-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="artifact-dialog" role="dialog" aria-modal="true" aria-labelledby="artifact-preview-title">
    <header><div><span className={`artifact-origin ${mode}`}>{mode === "demo" ? "静态演示 fixture" : "服务器产物"}</span><h2 id="artifact-preview-title">WebPPT 安全交互预览</h2><p>{mode === "online" ? "通过同源受鉴权地址加载；仅允许 Reveal 脚本运行，iframe 保持独立不透明 Origin，禁止表单、弹窗和顶层导航。" : "离线演示 fixture 禁止脚本和同源权限，不代表服务器生成结果。"}</p></div><button className="secondary" onClick={onClose} autoFocus aria-label="关闭 WebPPT 预览">关闭</button></header>
    <div className="artifact-dialog-meta"><span><b>类型</b>{artifact.kind}</span><span><b>修订</b>r{artifact.revision}</span><span><b>生成时间</b>{formatShanghaiDateTime(artifact.createdAt)}</span><span><b>Provider</b>{artifact.providerId}</span></div>
    <div className="artifact-frame-wrap">{(loading || (source && !frameLoaded)) && <div className="artifact-frame-state" role="status">正在加载 Reveal 交互预览…</div>}{error && <div className="artifact-frame-state error" role="alert">{error}</div>}{!loading && !error && source?.kind === "url" && <iframe title="WebPPT 安全交互预览" sandbox="allow-scripts" referrerPolicy="no-referrer" src={source.url} onLoad={() => setFrameLoaded(true)}/>} {!loading && !error && source?.kind === "html" && <iframe title="WebPPT 离线演示预览" sandbox="" referrerPolicy="no-referrer" srcDoc={hardenPreviewHtml(source.html)} onLoad={() => setFrameLoaded(true)}/>}</div>
    <footer><span><Icon name="shield"/> 脚本可运行 · 无同源权限</span><small>方向键、空格键或页面控件可翻页；讲稿备注不会显示在观众页面。</small></footer>
  </section></div>;
}

function ArtifactStatus({ artifacts, loading, error, mode, onRefresh, onPreview }: { artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const reveal = newestArtifact(artifacts,"reveal-html");
  return <div className={`artifact-status ${reveal ? "ready" : "waiting"}`}>
    <span className="artifact-status-icon"><Icon name={reveal ? "check" : "clock"}/></span>
    <div><b>{loading ? "正在检查 WebPPT 产物" : reveal ? `${mode === "demo" ? "演示" : "真实"} Reveal HTML 已就绪` : "尚无可预览的 Reveal HTML"}</b><small>{error || (reveal ? `r${reveal.revision} · ${formatBytes(reveal.byteLength)} · ${reveal.providerId}` : "生成完成后才能读取预览；不会以演示内容替代在线失败。")}</small></div>
    {reveal ? <button className="primary" onClick={() => onPreview(reveal)} disabled={loading}><Icon name="play"/>预览 WebPPT</button> : <button className="secondary" onClick={onRefresh} disabled={loading}>{loading ? "检查中…" : "重新检查"}</button>}
  </div>;
}

function DeckStep({ client, projectId, artifacts, loading, error, mode, onRefresh, onPreview }: { client: CourseClient; projectId?: string; artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const [slide,setSlide]=useState(2);
  const slides=["封面","为什么现在必须谈 AI 安全","一次看似普通的提问","你输入的，可能不只是一段文字","四类高风险信息","四步安全判断法"];
  if (mode === "online") return <DeckRevisionEditor client={client} projectId={projectId} onArtifactsChanged={onRefresh}/>;
  return <div className="deck-workspace"><aside className="slides-panel"><header><b>页面</b><span>设计草稿</span><button><Icon name="plus"/></button></header>{slides.map((title,index)=><button key={title} className={slide===index?"active":""} onClick={()=>setSlide(index)}><span>{String(index+1).padStart(2,"0")}</span><div className={`thumb thumb-${index}`}><small>{index===2?"一次看似普通的":"SECURITY"}</small><b>{index===2?"提问":"AI 安全"}</b></div><p>{title}</p></button>)}</aside><section className="stage"><div className="stage-bar"><span>页面设计草稿 {slide+1} / {slides.length}</span><div><button disabled>50%</button><button disabled><Icon name="play"/> 草稿演示</button></div></div><ArtifactStatus artifacts={artifacts} loading={loading} error={error} mode={mode} onRefresh={onRefresh} onPreview={onPreview}/><div className="slide-canvas"><span className="deck-kicker">DESIGN DRAFT · 非服务器产物预览</span><h1>一次看似普通的<br/><em>提问</em></h1><div className="chat-demo"><div className="chat-user"><span className="bot-avatar">AI</span><p>我可以帮你分析，<br/>请把数据粘贴到这里。</p></div><div className="chat-input">请分析这份用户流失明细…<span>↵</span></div><i className="data-chip one">customer_id</i><i className="data-chip two">手机号</i><i className="data-chip three">订单金额</i></div><footer><span>03</span><i/><small>GENERATIVE AI SAFETY</small></footer></div><div className="speaker-notes"><header><b><Icon name="mic"/> 讲稿草稿</b><span>尚未 TTS 实测</span><button disabled>展开</button></header><p>想象一下这个场景：你正在分析一份用户流失数据，为了更快找到原因，你打开了一个常用的 AI 工具……</p></div></section><aside className="ai-panel"><header><span><Icon name="spark"/> AI 设计助手</span><button><Icon name="more"/></button></header><div className="ai-thread"><div className="ai-msg"><span><Icon name="spark"/></span><p>当前编辑器仍是设计草稿。请使用中间的“预览 WebPPT”查看服务器生成的 Reveal HTML。</p></div></div><div className="ai-compose"><textarea aria-label="向 AI 描述修改" placeholder="AI 迭代尚未接入" disabled/><footer><span>后续批次开放</span><button aria-label="发送" disabled><Icon name="arrow"/></button></footer></div></aside></div>;
}

function durationLabel(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function NarrationStep({ client, projectId, artifacts, onRefresh }: { client: CourseClient; projectId?: string; artifacts: CourseArtifact[]; onRefresh:()=>void }) {
  const rows=["封面：守住数据边界","为什么现在必须谈 AI 安全","一次看似普通的提问","你输入的，可能不只是一段文字","四类高风险信息"];
  const manifestArtifact = artifacts.find((artifact) => artifact.kind === "tts-manifest");
  const [manifest, setManifest] = useState<SpeechManifest>();
  const [manifestError, setManifestError] = useState("");
  const [ttsJob,setTtsJob]=useState<GenerationJob>();const [starting,setStarting]=useState(false);const stopTtsWatch=useRef<(()=>void)|undefined>(undefined);const deckArtifact=newestArtifact(artifacts,"deck-spec");
  useEffect(()=>()=>stopTtsWatch.current?.(),[]);
  useEffect(() => {
    setManifest(undefined); setManifestError("");
    if (!projectId || !manifestArtifact || client.mode !== "online") return;
    void client.getArtifactContent(projectId, manifestArtifact.artifactId).then((text) => {
      const value = JSON.parse(text) as SpeechManifest;
      if (!Array.isArray(value.slides) || !Number.isFinite(value.totalMeasuredDurationMs)) throw new Error("TTS Manifest 格式无效");
      setManifest(value);
    }).catch((reason: unknown) => setManifestError(reason instanceof Error ? reason.message : "TTS Manifest 读取失败"));
  }, [client, projectId, manifestArtifact]);
  const startTts=async()=>{if(!projectId||!deckArtifact||client.mode!=="online")return;setStarting(true);setManifestError("");try{const next=await client.startTtsGeneration(projectId,{snapshotId:deckArtifact.configurationVersion,deckArtifactId:deckArtifact.artifactId});setTtsJob(next);stopTtsWatch.current?.();stopTtsWatch.current=client.watchJob(next.jobId,job=>{setTtsJob(job);if(job.status==="completed"){stopTtsWatch.current?.();stopTtsWatch.current=undefined;onRefresh();}else if(job.status==="failed"||job.status==="cancelled"){stopTtsWatch.current?.();stopTtsWatch.current=undefined;const detail=job.events.at(-1)?.message;setManifestError(job.status==="failed"?`TTS 任务失败：${detail??"请查看任务事件或服务日志"}`:"TTS 任务已取消");}},reason=>setManifestError(`TTS 进度读取失败：${reason.message}`));}catch(reason){setManifestError(reason instanceof Error?reason.message:"TTS 启动失败");}finally{setStarting(false);}};
  if (!manifest || !projectId) return <div className="content-wide"><SectionTitle eyebrow="STEP 08 · NARRATION & TIMING" title="讲稿与配音等待配置" desc="TTS 能力已实现；未配置 Provider 或未完成目标机验收时没有真实 TTS 音频、实测时长或自动校准结果。"/>{manifestError && <div className="error-banner" role="alert">{manifestError}</div>}<div className="timing-actions"><button className="primary" onClick={()=>void startTts()} disabled={!deckArtifact||client.mode!=="online"||starting||ttsJob?.status==="running"||ttsJob?.status==="queued"}>{starting?"正在启动…":ttsJob&&!["completed","failed","cancelled"].includes(ttsJob.status)?`合成中 ${ttsJob.progressPercent}%`:"启动真实 TTS 合成"}</button><button className="secondary" onClick={onRefresh}>刷新真实产物</button></div><div className="timing-overview"><div className="timeline-ring"><span><b>待测</b><small>目标 20:00</small></span></div><div><b>时长匹配度</b><h2>–</h2><p><span className="warning-dot">需要 TTS Provider 实测</span></p></div><div className="voice"><span className="voice-avatar">TTS</span><p><b>尚未选择真实音色</b><small>MeloTTS / Kokoro / Piper 可切换；需配置模型并完成目标机验收</small></p><button disabled><Icon name="play"/> 暂无音频</button></div></div><div className="narration-table"><header><span>页面与讲稿</span><span>字数</span><span>实测时长</span><span>状态</span><span/></header>{rows.map((title,index)=><div key={title}><span><i>{String(index+1).padStart(2,"0")}</i><b>{title}</b></span><span>–</span><span>–</span><span className="warn">等待合成</span><button disabled><Icon name="chevron"/></button></div>)}</div></div>;
  return <div className="content-wide"><SectionTitle eyebrow="STEP 08 · NARRATION & TIMING" title="真实配音与实测时长" desc={`由 ${manifest.providerId} / ${manifest.engineRevision} 生成；所有时间来自 WAV 样本数。`}/><div className="timing-overview"><div className="timeline-ring"><span><b>{durationLabel(manifest.totalMeasuredDurationMs)}</b><small>实测总时长</small></span></div><div><b>逐页时长状态</b><h2>{manifest.slides.filter((slide) => slide.timingStatus === "within-tolerance").length} / {manifest.slides.length}</h2><p><span className={manifest.slides.every((slide) => slide.timingStatus === "within-tolerance") ? "good" : "warning-dot"}>超差页面需改稿后重合成</span></p></div><div className="voice"><span className="voice-avatar">TTS</span><p><b>{manifest.voiceId}</b><small>{manifest.providerId} · {manifest.engineRevision}</small></p></div></div><div className="narration-table"><header><span>页面与讲稿</span><span>句数</span><span>实测时长</span><span>状态</span><span/></header>{manifest.slides.map((slide)=><div key={slide.slideId}><span><i>{String(slide.order+1).padStart(2,"0")}</i><b>{slide.slideId}</b></span><span>{slide.sentences.length}</span><span>{durationLabel(slide.measuredDurationMs)}</span><span className={slide.timingStatus === "within-tolerance" ? "ok" : "warn"}>{slide.timingStatus === "within-tolerance" ? "已校准" : "需改稿"}</span><audio controls preload="none" crossOrigin="use-credentials" src={client.getArtifactContentUrl(projectId, slide.audioArtifactId)}/></div>)}</div><div className="timing-actions"><a className="secondary" href={client.getArtifactContentUrl(projectId, manifest.vttArtifactId)}>下载 VTT</a><a className="secondary" href={client.getArtifactContentUrl(projectId, manifest.srtArtifactId)}>下载 SRT</a></div></div>;
}

function newestArtifact(artifacts: CourseArtifact[], kind: string) {
  return artifacts.filter((artifact) => artifact.kind === kind).sort((left, right) => right.revision - left.revision || Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

function parseSpeechManifest(text: string): SpeechManifest {
  const value = JSON.parse(text) as SpeechManifest;
  if (!value || !value.configurationSnapshotId || !value.deckArtifactId || !Array.isArray(value.slides)) throw new Error("TTS Manifest 缺少视频渲染所需的快照或 Deck 信息");
  return value;
}

function parseVideoManifest(text: string): VideoRenderManifest {
  const value = JSON.parse(text) as VideoRenderManifest;
  if (!value || !value.mp4ArtifactId || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || !value.rendererRevision || value.width !== 1920 || value.height !== 1080 || value.fps !== 30 || value.videoCodec !== "h264" || value.audioCodec !== "aac") throw new Error("Video Manifest 格式或编码约束无效");
  return value;
}

function VideoStep({ client, projectId, artifacts, loading, error, mode, onRefresh, onPreview }: { client: CourseClient; projectId?: string; artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const revealArtifact = newestArtifact(artifacts, "reveal-html");
  const deckArtifact = newestArtifact(artifacts, "deck-spec");
  const renderManifestArtifact = newestArtifact(artifacts, "render-manifest");
  const speechManifestArtifact = newestArtifact(artifacts, "tts-manifest");
  const videoManifestArtifact = newestArtifact(artifacts, "video-manifest");
  const [speechManifest, setSpeechManifest] = useState<SpeechManifest>();
  const [videoManifest, setVideoManifest] = useState<VideoRenderManifest>();
  const [manifestError, setManifestError] = useState("");
  const [renderJob, setRenderJob] = useState<GenerationJob>();
  const [renderError, setRenderError] = useState("");
  const [starting, setStarting] = useState(false);
  const stopRenderWatch = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => stopRenderWatch.current?.(), []);

  useEffect(() => {
    setSpeechManifest(undefined); setVideoManifest(undefined); setManifestError("");
    if (!projectId || client.mode !== "online") return;
    const reads: Promise<void>[] = [];
    if (speechManifestArtifact) reads.push(client.getArtifactContent(projectId, speechManifestArtifact.artifactId).then((text) => { setSpeechManifest(parseSpeechManifest(text)); }));
    if (videoManifestArtifact) reads.push(client.getArtifactContent(projectId, videoManifestArtifact.artifactId).then((text) => { setVideoManifest(parseVideoManifest(text)); }));
    void Promise.all(reads).catch((reason: unknown) => setManifestError(reason instanceof Error ? reason.message : "视频产物清单读取失败"));
  }, [client, projectId, speechManifestArtifact?.artifactId, videoManifestArtifact?.artifactId]);

  const mp4Artifact = videoManifest ? artifacts.find((artifact) => artifact.kind === "video-mp4" && artifact.artifactId === videoManifest.mp4ArtifactId && artifact.mediaType === "video/mp4") : undefined;
  const videoInputsPresent = Boolean(videoManifest && projectId && videoManifest.projectId === projectId && artifacts.some((artifact) => artifact.kind === "deck-spec" && artifact.artifactId === videoManifest.deckArtifactId) && artifacts.some((artifact) => artifact.kind === "reveal-html" && artifact.artifactId === videoManifest.revealArtifactId) && artifacts.some((artifact) => artifact.kind === "tts-manifest" && artifact.artifactId === videoManifest.speechManifestArtifactId));
  const canStart = Boolean(mode === "online" && projectId && speechManifestArtifact && speechManifest && revealArtifact && deckArtifact && speechManifest.deckArtifactId === deckArtifact.artifactId && !videoManifestArtifact);
  const missingReason = mode === "demo" ? "演示模式不会启动真实渲染" : !projectId ? "请先创建项目" : videoManifestArtifact && videoManifest && !mp4Artifact ? "Video Manifest 未绑定可读取的真实 MP4" : videoManifestArtifact && videoManifest && mp4Artifact && !videoInputsPresent ? "视频输入产物链不完整，播放器已拒绝加载" : !speechManifestArtifact ? "需要先生成真实 TTS Manifest" : !speechManifest ? "正在校验 TTS Manifest" : !deckArtifact || !revealArtifact ? "缺少 Deck 或 Reveal HTML 产物" : speechManifest.deckArtifactId !== deckArtifact.artifactId ? "TTS 与最新 Deck 不属于同一产物链" : videoManifestArtifact ? "已有视频产物，请先检查或刷新" : "";

  const startRender = async () => {
    if (!canStart || !projectId || !speechManifest || !speechManifestArtifact || !revealArtifact || !deckArtifact) return;
    setStarting(true); setRenderError("");
    try {
      const nextJob = await client.startVideoGeneration(projectId, {
        snapshotId: speechManifest.configurationSnapshotId,
        deckArtifactId: deckArtifact.artifactId,
        revealArtifactId: revealArtifact.artifactId,
        speechManifestArtifactId: speechManifestArtifact.artifactId,
        ...(renderManifestArtifact ? { renderManifestArtifactId: renderManifestArtifact.artifactId } : {}),
      });
      setRenderJob(nextJob);
      stopRenderWatch.current?.();
      stopRenderWatch.current = client.watchJob(nextJob.jobId, (job) => {
        setRenderJob(job);
        if (job.status === "completed") { stopRenderWatch.current?.(); stopRenderWatch.current = undefined; onRefresh(); }
      }, (reason) => setRenderError(`视频渲染进度读取失败：${reason.message}`));
    } catch (reason) { setRenderError(reason instanceof Error ? reason.message : "视频渲染启动失败"); }
    finally { setStarting(false); }
  };

  const generated = Boolean(videoManifestArtifact && videoManifest && mp4Artifact && videoInputsPresent);
  return <div className="content-narrow video-complete">
    <span className={`complete-badge ${generated ? "" : "waiting"}`}><Icon name={generated ? "check" : "clock"} size={28}/></span>
    <span className="eyebrow">STEP 09 · VIDEO DELIVERY</span>
    <h1>{generated ? "真实培训视频已生成" : "等待真实视频渲染"}</h1>
    <p>{generated ? "播放器、时长与渲染版本均来自服务器 Video Manifest 和其绑定的 MP4。" : "只有完整的 WebPPT、TTS Manifest 与同链路产物通过校验后，才能启动视频渲染。"}</p>
    <ArtifactStatus artifacts={artifacts} loading={loading} error={error} mode={mode} onRefresh={onRefresh} onPreview={onPreview}/>
    {(manifestError || renderError) && <div className="error-banner" role="alert">{manifestError || renderError}</div>}
    {generated && videoManifest && mp4Artifact && projectId ? <div className="video-player real-video"><video controls preload="metadata" playsInline crossOrigin="use-credentials" src={client.getArtifactContentUrl(projectId, mp4Artifact.artifactId)}>浏览器不支持 HTML5 视频播放。</video></div> : <div className="video-player"><div className="video-frame"><span>COURSEFORGE · VIDEO RENDER</span><h2>真实 MP4<br/><em>{renderJob ? `${renderJob.stage} · ${renderJob.progressPercent}%` : "尚未生成"}</em></h2><button aria-label="没有真实 MP4，视频播放不可用" disabled><Icon name="play" size={26}/></button><footer>非视频占位画面 <small>NO VERIFIED MP4</small></footer></div></div>}
    <div className="quality-row"><div><Icon name={generated ? "check" : "clock"}/><span><b>{generated ? durationLabel(videoManifest!.durationMs) : "–"}</b><small>Manifest 实测时长</small></span></div><div><Icon name={generated ? "check" : "clock"}/><span><b>{generated ? `${videoManifest!.width} × ${videoManifest!.height}` : "待渲染"}</b><small>输出分辨率</small></span></div><div><Icon name={generated ? "check" : "clock"}/><span><b>{generated ? videoManifest!.rendererRevision : renderJob ? `${renderJob.progressPercent}%` : "未启动"}</b><small>{generated ? `${videoManifest!.providerId} · ${videoManifest!.fps} fps` : "真实任务进度"}</small></span></div><div><Icon name="shield"/><span><b>{generated ? formatShanghaiDateTime(videoManifest!.createdAt) : "受保护"}</b><small>{generated ? "生成时间" : "登录和项目权限"}</small></span></div></div>
    <div className="delivery-actions">{generated && mp4Artifact && projectId ? <a className="primary" href={client.getArtifactContentUrl(projectId, mp4Artifact.artifactId)} download><Icon name="video"/> 下载 MP4</a> : <button className="primary" onClick={() => { void startRender(); }} disabled={!canStart || starting || renderJob?.status === "running" || renderJob?.status === "queued"} title={missingReason}>{starting ? "正在启动…" : renderJob && !["completed", "failed", "cancelled"].includes(renderJob.status) ? `渲染中 ${renderJob.progressPercent}%` : "启动视频渲染"}</button>}<button className="secondary" onClick={onRefresh} disabled={loading}>{loading ? "检查中…" : "刷新真实产物"}</button></div>
    {!generated && <small className="video-gate" role="status">{missingReason || "渲染完成后将显示真实播放器、时长、版本和下载入口。"}</small>}
    {generated && videoManifest && <QaPublicationPanel client={client} projectId={projectId!} deckArtifactId={videoManifest.deckArtifactId} speechManifestArtifactId={videoManifest.speechManifestArtifactId} videoManifestArtifactId={videoManifestArtifact!.artifactId}/>}
  </div>;
}

type QueuedSource = { file: File; status: "ready" | "uploading" | "uploaded" | "error"; progress: number; error?: string; revision?: SourceRevision };
const SOURCE_LIMITS: Record<string, number> = { ".txt": 2 * 1024 * 1024, ".md": 2 * 1024 * 1024, ".markdown": 2 * 1024 * 1024, ".pdf": 10 * 1024 * 1024, ".docx": 10 * 1024 * 1024, ".pptx": 20 * 1024 * 1024 };

function SourceIntake({ mode, sources, onFiles, onRemove }: { mode: "online" | "demo"; sources: QueuedSource[]; onFiles: (files: FileList | File[]) => void; onRemove: (index: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputId = "source-file-input";
  return <>
    <div className={`upload-zone ${dragging ? "dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); if (mode === "online") setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (mode === "online") onFiles(event.dataTransfer.files); }}>
      <span><Icon name="upload" size={26}/></span><h3>拖入 TXT、Markdown、PDF、DOCX 或 PPTX</h3>
      <p>TXT/Markdown 最大 2 MB，PDF/DOCX 最大 10 MB，PPTX 最大 20 MB；文档由隔离解析器进行只读文本提取。</p>
      <input id={inputId} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.pdf,.docx,.pptx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation" multiple disabled={mode === "demo"} onChange={(event) => { if (event.target.files) onFiles(event.target.files); event.currentTarget.value = ""; }}/>
      <label className={`secondary upload-label ${mode === "demo" ? "disabled" : ""}`} htmlFor={inputId}>{mode === "demo" ? "演示模式不读取文件" : "选择文件"}</label>
      {mode === "demo" && <small className="upload-honesty" role="status">切换到在线模式并登录后，才能把材料写入真实项目。</small>}
    </div>
    {sources.length > 0 && <div className="source-upload-list" aria-live="polite"><header><b>材料队列</b><span>创建项目后自动上传并生成不可变 SourceRevision</span></header>{sources.map((source, index) => <div className={`source-upload-item ${source.status}`} key={`${source.file.name}-${source.file.lastModified}`}>
      <span className="source-file-icon"><Icon name={source.status === "uploaded" ? "check" : source.status === "error" ? "bell" : "book"}/></span>
      <div><b>{source.file.name}</b><small>{formatBytes(source.file.size)} · {source.status === "ready" ? "已在本地预检，等待创建项目" : source.status === "uploading" ? `上传并解析 ${source.progress}%` : source.status === "uploaded" ? `SourceRevision r${source.revision?.revision} · ${source.revision?.sections.length ?? 0} 段` : source.error}</small>{source.status === "uploading" && <progress max="100" value={source.progress}>{source.progress}%</progress>}</div>
      {source.status === "ready" || source.status === "error" ? <button type="button" onClick={() => onRemove(index)} aria-label={`移除 ${source.file.name}`}>×</button> : <span className="source-state">{source.status === "uploaded" ? "已保存" : "处理中"}</span>}
      {source.revision && <div className="source-revision-detail"><code>SourceRevision {source.revision.sourceRevisionId}</code><code>导入时间 {formatShanghaiDateTime(source.revision.importedAt)}</code><code title={source.revision.contentSha256}>SHA-256 {source.revision.contentSha256.slice(0, 16)}…</code>{source.revision.sections.slice(0, 3).map((section) => <blockquote key={section.sectionId}><b>{section.heading || `段落 ${section.ordinal + 1}`}</b><span>{describeSourceLocator(section.locator)} · {section.sectionId}</span><p>{section.text.slice(0, 140)}{section.text.length > 140 ? "…" : ""}</p></blockquote>)}</div>}
    </div>)}</div>}
  </>;
}

function SimpleStep({ step, mode, sources, idea, onIdea, onFiles, onRemove, policy, onPolicy }: { step:number; mode: "online" | "demo"; sources: QueuedSource[]; idea:string; onIdea:(value:string)=>void; onFiles: (files: FileList | File[]) => void; onRemove: (index: number) => void; policy:import("@/lib/course-client").ProjectDataPolicy;onPolicy:(value:import("@/lib/course-client").ProjectDataPolicy)=>void }) {
  const intake=step===0;
  const choose=(selected:import("@/lib/course-client").ProjectDataPolicy["mode"])=>{const value={schemaVersion:"1" as const,mode:selected,classification:selected==="offline"?"private" as const:selected==="internal"?"internal" as const:"public" as const};onPolicy(value);};
  return <div className="content-narrow"><SectionTitle eyebrow={`STEP 0${step+1} · ${intake?"SOURCE INTAKE":"DATA POLICY"}`} title={intake?"从点子或培训材料开始":"确认这次生成的数据边界"} desc={intake?"可把 TXT、Markdown、PDF、DOCX 与 PPTX 安全解析为可追溯 SourceRevision 并绑定到真实项目。":"策略会持久化到项目；越界 Provider 调用会被明确拒绝。"}/>{intake?<><SourceIntake mode={mode} sources={sources} onFiles={onFiles} onRemove={onRemove}/><div className="or"><span/>或者<span/></div><div className="idea-box"><label htmlFor="idea">描述你的培训点子</label><textarea id="idea" rows={5} value={idea} onChange={event=>onIdea(event.target.value)}/></div></>:<div className="policy-grid"><button type="button" className={policy.mode==="internal"?"selected":""} onClick={()=>choose("internal")}><span><Icon name="shield"/></span><b>内部受控</b><p>仅允许标记 internal 且 origin/executable 精确匹配的服务。</p></button><button type="button" className={policy.mode==="public-only"?"selected":""} onClick={()=>choose("public-only")}><span><Icon name="search"/></span><b>仅公开信息</b><p>只发送结构化公开查询，不发送内部正文或 Brief 字段。</p></button><button type="button" className={policy.mode==="offline"?"selected":""} onClick={()=>choose("offline")}><span><Icon name="folder"/></span><b>完全离线 · 默认</b><p>禁止外部文本、搜索、设计与多模态调用。</p></button></div>}</div>;
}

const stageToStep: Record<string, number> = { intake: 0, research: 3, material: 4, deck: 6, narration: 7, tts: 7, render: 8, qa: 8, publish: 8 };

function Wizard({ client, onExit }: { client: CourseClient; onExit: () => void }) {
  const [step,setStep]=useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<GenerationJob>();
  const [latestEvent, setLatestEvent] = useState<JobEvent>();
  const [projectId, setProjectId] = useState<string>();
  const [artifacts, setArtifacts] = useState<CourseArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactError, setArtifactError] = useState("");
  const [previewArtifact, setPreviewArtifact] = useState<CourseArtifact>();
  const [previewSource, setPreviewSource] = useState<ArtifactPreviewSource>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [stopWatching, setStopWatching] = useState<(() => void) | null>(null);
  const [queuedSources, setQueuedSources] = useState<QueuedSource[]>([]);
  const [ideaDraft,setIdeaDraft]=useState("给全体员工做一堂 20 分钟的生成式 AI 安全培训，结合近期真实办公场景，重点讲清楚哪些数据不能输入外部 AI 工具。");
  const [dataPolicy,setDataPolicy]=useState<import("@/lib/course-client").ProjectDataPolicy>({schemaVersion:"1",mode:"offline",classification:"private"});
  useEffect(() => () => { stopWatching?.(); }, [stopWatching]);
  const queueFiles = async (incoming: FileList | File[]) => {
    const candidates = Array.from(incoming);
    const next: QueuedSource[] = [];
    for (const file of candidates) {
      const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      let failure = "";
      const maxBytes = SOURCE_LIMITS[extension];
      if (!maxBytes) failure = "仅支持 .txt、.md、.markdown、.pdf、.docx、.pptx";
      else if (file.size < 1 || file.size > maxBytes) failure = `文件必须在 1 B–${formatBytes(maxBytes)} 之间`;
      else if ([".txt", ".md", ".markdown"].includes(extension)) {
        try { const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); if (!text.trim()) failure = "文件没有可提取的文本"; }
        catch { failure = "文件不是有效的 UTF-8 文本"; }
      }
      next.push({ file, status: failure ? "error" : "ready", progress: 0, ...(failure ? { error: failure } : {}) });
    }
    setQueuedSources((current) => [...current, ...next].slice(0, 20));
  };
  const submitBrief = async (brief: CourseBriefInput, snapshotId?: string) => {
    setPending(true); setError(""); stopWatching?.();
    try {
      const invalidSource = queuedSources.find((source) => source.status === "error");
      if (invalidSource) throw new Error(`请先移除或重新选择无效材料：${invalidSource.file.name}`);
      const project = projectId ? await client.updateProjectBrief(projectId,brief,dataPolicy) : await client.createProject(brief,dataPolicy);
      if (!projectId) setProjectId(project.id);
      setArtifacts([]);
      for (let index = 0; index < queuedSources.length; index += 1) {
        const queued = queuedSources[index];
        if (!queued || queued.status !== "ready") continue;
        setQueuedSources((current) => current.map((item, candidate) => candidate === index ? { ...item, status: "uploading", progress: 1 } : item));
        try {
          const revision = await client.uploadSource(project.id, queued.file, (progress) => setQueuedSources((current) => current.map((item, candidate) => candidate === index ? { ...item, status: "uploading", progress } : item)));
          setQueuedSources((current) => current.map((item, candidate) => candidate === index ? { ...item, status: "uploaded", progress: 100, revision } : item));
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "材料上传失败";
          setQueuedSources((current) => current.map((item, candidate) => candidate === index ? { ...item, status: "error", error: message } : item));
          throw new Error(`${queued.file.name}：${message}`);
        }
      }
      if(client.mode==="online"&&dataPolicy.mode!=="internal")throw new Error(dataPolicy.mode==="offline"?"完全离线策略已保存，但当前尚无本地文本/设计模型，不能启动 AI 全链路。":"仅公开信息策略已保存，但当前完整生成会发送 Brief/材料；请改用内部受控策略。独立的公开检索启动入口尚未接入。");
      const started = client.mode === "online" ? await client.startContentGeneration(project.id, snapshotId ?? "") : await client.startGeneration(project.id);
      setJob(started);
      const stop = client.watchJob(started.jobId, (nextJob, events) => {
        setJob(nextJob);
        const latest = events.at(-1) ?? nextJob.events.at(-1);
        if (latest) { setLatestEvent(latest); setStep(stageToStep[latest.stage] ?? 1); }
      }, (reason) => setError(`进度连接中断：${reason.message}。系统将自动重试。`));
      setStopWatching(() => stop);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建项目失败");
      throw reason;
    } finally { setPending(false); }
  };
  const refreshArtifacts = async () => {
    if (!projectId) { setArtifactError("请先提交 Brief 并创建项目。"); return; }
    setArtifactsLoading(true); setArtifactError("");
    try { setArtifacts(await client.listArtifacts(projectId)); }
    catch (reason) { setArtifactError(reason instanceof Error ? reason.message : "产物列表读取失败"); }
    finally { setArtifactsLoading(false); }
  };
  useEffect(() => {
    if (projectId && (step >= 3 || job?.status === "completed")) void refreshArtifacts();
    // 任务到达 deck 或完成时重新读取一次；手动重试由界面按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, step, job?.status, job?.stage]);
  const openPreview = async (artifact: CourseArtifact) => {
    if (!projectId) return;
    setPreviewArtifact(artifact); setPreviewSource(undefined); setPreviewError(""); setPreviewLoading(true);
    try { setPreviewSource(await client.getArtifactPreviewSource(projectId, artifact.artifactId)); }
    catch (reason) { setPreviewError(reason instanceof Error ? reason.message : "HTML 产物读取失败"); }
    finally { setPreviewLoading(false); }
  };
  const closePreview = () => { setPreviewArtifact(undefined); setPreviewSource(undefined); setPreviewError(""); };
  const artifactProps = { artifacts, loading: artifactsLoading, error: artifactError, mode: client.mode, onRefresh: () => { void refreshArtifacts(); }, onPreview: (artifact: CourseArtifact) => { void openPreview(artifact); } };
  const content=useMemo(()=>{if(step===0||step===1)return <SimpleStep step={step} mode={client.mode} sources={queuedSources} idea={ideaDraft} onIdea={setIdeaDraft} onFiles={(files) => { void queueFiles(files); }} onRemove={(index) => setQueuedSources((current) => current.filter((_, candidate) => candidate !== index))} policy={dataPolicy} onPolicy={setDataPolicy}/>;if(step===2)return <BriefStep client={client} idea={ideaDraft} policy={dataPolicy} onSubmit={submitBrief} pending={pending} error={error} mode={client.mode}/>;if(step===3)return <MaterialStep research mode={client.mode} client={client} projectId={projectId} artifacts={artifacts}/>;if(step===4)return client.mode==="online"?<MaterialRevisionEditor client={client} projectId={projectId}/>:<MaterialStep mode={client.mode} client={client} projectId={projectId} artifacts={artifacts}/>;if(step===5)return <><DesignStep client={client} projectId={projectId} artifacts={artifacts} onArtifactsChanged={()=>{void refreshArtifacts()}}/>{projectId&&client.mode==="online"&&<ImageSearchPanel client={client} projectId={projectId} onImported={()=>undefined}/>}</>;if(step===6)return <DeckStep client={client} projectId={projectId} {...artifactProps}/>;if(step===7)return <NarrationStep client={client} projectId={projectId} artifacts={artifacts} onRefresh={()=>{void refreshArtifacts()}}/>;return <VideoStep client={client} projectId={projectId} {...artifactProps}/>;},[step, pending, error, artifacts, artifactsLoading, artifactError, client, queuedSources, projectId, ideaDraft, dataPolicy]);
  return <div className="wizard-shell"><ProgressHeader step={step} onExit={onExit} job={job} latestEvent={latestEvent} mode={client.mode}/><StepNav step={step} setStep={setStep}/><main className={step===6?"deck-main":"wizard-main"}>{error && step !== 2 && <div className="error-banner compact" role="alert"><span><b>任务状态提示</b>{error}</span></div>}{content}</main>{step!==6&&<div className="step-controls"><button className="secondary" onClick={()=>setStep(Math.max(0,step-1))} disabled={step===0}>上一步</button><span>{job ? `生成 ${job.progressPercent}% · ${job.status}` : `步骤 ${step+1} / 9`}</span><button className="primary" onClick={()=>setStep(Math.min(8,step+1))} disabled={step===8 || pending}>保存并继续 <Icon name="arrow"/></button></div>}{previewArtifact && <ArtifactPreviewDialog artifact={previewArtifact} source={previewSource} mode={client.mode} loading={previewLoading} error={previewError} onClose={closePreview}/>}</div>;
}

function LoginScreen({ client, onAuthenticated, onDemo }: { client: CourseClient; onAuthenticated: (user: AuthUser) => void; onDemo: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return <main className="auth-page"><section className="auth-brand"><Logo/><span className="ai-pill"><Icon name="shield" size={14}/> INTERNAL ALPHA</span><h1>把一份安全知识，<br/>锻造成一堂好课。</h1><p>从培训 Brief 到 WebPPT、讲稿和视频，在一个可追溯的工作流中完成。</p><div className="auth-meta"><span><Icon name="check"/> 结构化课程材料</span><span><Icon name="check"/> 逐页生成进度</span><span><Icon name="check"/> 模块化模型与渲染</span></div></section><section className="auth-panel"><form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setPending(true); setError(""); void client.login(String(data.get("email")), String(data.get("password"))).then(onAuthenticated).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "登录失败")).finally(() => setPending(false)); }}><span className="eyebrow">COURSEFORGE</span><h2>登录内部 Alpha</h2><p>使用管理员为你创建的内部账号。</p><label htmlFor="login-email">邮箱</label><input id="login-email" name="email" type="email" autoComplete="username" required placeholder="name@company.com"/><label htmlFor="login-password">密码</label><input id="login-password" name="password" type="password" autoComplete="current-password" required minLength={8}/>{error && <div className="login-error" role="alert">{error}</div>}<button className="primary" disabled={pending}>{pending ? "正在登录…" : "登录"}<Icon name="arrow"/></button><div className="demo-divider"><span/>API 暂不可用？<span/></div><button className="secondary demo-button" type="button" onClick={onDemo}>明确进入离线演示模式</button><small>演示模式不调用 API，创建结果只保留在当前页面会话。</small></form></section></main>;
}

function ConnectionScreen({ onRetry, onDemo, error }: { onRetry: () => void; onDemo: () => void; error: string }) {
  return <main className="connection-page"><Logo/><div className="connection-card"><span className="connection-icon"><Icon name="settings" size={25}/></span><span className="eyebrow">CONNECTION REQUIRED</span><h1>{apiBaseUrl ? "CourseForge API 暂时不可达" : "尚未配置 CourseForge API"}</h1><p>{error || "请通过 NEXT_PUBLIC_COURSEFORGE_API_BASE_URL 配置 API 基础地址，然后重新构建前端。"}</p>{apiBaseUrl && <code>{apiBaseUrl}</code>}<div><button className="primary" onClick={onRetry}>重新连接</button><button className="secondary" onClick={onDemo}>进入离线演示</button></div><small>系统不会在连接失败时静默使用模拟数据。</small></div></main>;
}

export default function Home() {
  const [client, setClient] = useState<CourseClient | null>(onlineCourseClient);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [view,setView]=useState<"dashboard"|"wizard"|"admin">("dashboard");
  const [booting, setBooting] = useState(Boolean(onlineCourseClient));
  const [connectionError, setConnectionError] = useState("");
  const checkSession = () => {
    if (!onlineCourseClient) { setBooting(false); return; }
    setBooting(true); setConnectionError(""); setClient(onlineCourseClient);
    void onlineCourseClient.me().then(setUser).catch((reason: unknown) => {
      if (reason && typeof reason === "object" && "status" in reason && (reason as { status?: number }).status === 401) return;
      setConnectionError(reason instanceof Error ? reason.message : "API 连接失败"); setClient(null);
    }).finally(() => setBooting(false));
  };
  useEffect(checkSession, []);
  const enterDemo = () => { setClient(demoCourseClient); setUser({ id: "demo-user", displayName: "演示用户", role: "course_editor" }); setConnectionError(""); };
  const logout = () => { if (!client) return; void client.logout().finally(() => { setUser(null); setView("dashboard"); if (client.mode === "demo") setClient(onlineCourseClient); }); };
  if (booting) return <main className="boot-screen" role="status"><Logo/><span className="boot-spinner"/>正在连接 CourseForge API…</main>;
  if (!client) return <ConnectionScreen onRetry={checkSession} onDemo={enterDemo} error={connectionError}/>;
  if (!user) return <LoginScreen client={client} onAuthenticated={setUser} onDemo={enterDemo}/>;
  if (view === "admin" && (user.role === "platform_admin" || user.role === "auditor")) return <AppShell active="admin" user={user} mode={client.mode} onHome={() => setView("dashboard")} onAdmin={() => setView("admin")} onLogout={logout}><AdminConsole client={client} user={user}/></AppShell>;
  return view==="dashboard"?<Dashboard client={client} user={user} onLogout={logout} onAdmin={() => setView("admin")} onOpen={()=>setView("wizard")}/>:<Wizard client={client} onExit={()=>setView("dashboard")}/>;
}
