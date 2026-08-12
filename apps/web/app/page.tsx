"use client";

import { useEffect, useMemo, useState } from "react";
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
} from "@/lib/course-client";

const steps = [
  ["01", "输入材料", "汇集点子与资料"],
  ["02", "培训 Brief", "定义目标与受众"],
  ["03", "联网策略", "确认数据边界"],
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

function AppShell({ children, user, mode, active = "home", onHome, onLogout }: { children: React.ReactNode; user: AuthUser; mode: "online" | "demo"; active?: string; onHome?: () => void; onLogout: () => void }) {
  return <div className="app-shell">
    <aside className="side-rail">
      <Logo />
      <nav aria-label="主要导航">
        <button className={active === "home" ? "active" : ""} onClick={onHome}><Icon name="grid"/><span>工作台</span></button>
        <button className={active === "projects" ? "active" : ""}><Icon name="folder"/><span>我的项目</span></button>
        <button><Icon name="book"/><span>模板中心</span></button>
        <div className="nav-gap" />
        <button><Icon name="settings"/><span>系统设置</span></button>
      </nav>
      <div className="rail-bottom">
        <div className="storage"><span>存储空间</span><b>32%</b><i><em /></i><small>12.8 GB / 40 GB</small></div>
        <div className="user"><span className="avatar">{user.displayName.slice(0, 1)}</span><span><b>{user.displayName}</b><small>{mode === "demo" ? "演示模式" : user.role}</small></span><button className="user-logout" onClick={onLogout} aria-label="退出登录" title="退出登录"><Icon name="more"/></button></div>
      </div>
    </aside>
    <main>{children}</main>
  </div>;
}

function Dashboard({ client, user, onOpen, onLogout }: { client: CourseClient; user: AuthUser; onOpen: () => void; onLogout: () => void }) {
  const [projects, setProjects] = useState<CourseProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadProjects = () => { setLoading(true); setError(""); void client.listProjects().then(setProjects).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "项目读取失败")).finally(() => setLoading(false)); };
  const activeCount = projects.filter((project) => project.status !== "completed").length;
  const completedCount = projects.filter((project) => project.status === "completed").length;
  useEffect(loadProjects, [client]);
  return <AppShell active="home" user={user} mode={client.mode} onLogout={onLogout}>
    <header className="topbar"><span className={`connection-pill ${client.mode}`} role="status"><i/>{client.mode === "online" ? "内部 Alpha · API 已连接" : "离线演示 · 数据不会保存"}</span><div className="search"><Icon name="search"/><input aria-label="搜索" placeholder="搜索项目、培训材料或模板"/><kbd>⌘ K</kbd></div><button className="icon-button" aria-label="通知"><Icon name="bell"/><i /></button></header>
    <div className="dashboard">
      <section className="welcome">
        <div><span className="eyebrow">COURSEFORGE · INTERNAL ALPHA</span><h1>你好，{user.displayName}</h1><p>把安全知识，变成真正有人愿意看完的培训。</p></div>
        <button className="primary" onClick={onOpen}><Icon name="plus"/>创建新培训</button>
      </section>
      <section className="hero-card">
        <div className="hero-orb orb-one"/><div className="hero-orb orb-two"/>
        <div className="hero-copy"><span className="ai-pill"><Icon name="spark" size={14}/> AI 课程向导</span><h2>从一个想法，到一堂完整的课</h2><p>导入制度、文档或已有 PPT，AI 将协助完成研究、设计、讲稿与视频制作。</p><button onClick={onOpen}>开始创作 <Icon name="arrow"/></button></div>
        <div className="hero-visual" aria-hidden="true"><div className="mini-deck"><span className="mini-top"><i/><i/><i/></span><b>守住数据边界</b><small>从一次真实的误发事件开始</small><div className="signal"><em/><em/><em/><em/><em/></div></div><span className="float-tag one"><Icon name="wand"/> AI 生成</span><span className="float-tag two"><Icon name="video"/> 视频就绪</span></div>
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
  return <header className="wizard-top"><button className="back-link" onClick={onExit}><Icon name="chevron"/> 返回工作台</button><div className="wizard-title"><b>新建安全培训</b><span>{mode === "demo" ? "演示模式 · 不会保存到服务器" : "内部 Alpha · 已连接 API"}</span></div><div className="run-state" aria-live="polite"><span className="pulse"/><span><b>{percent}%</b><small>{job ? `${latestEvent?.message ?? "任务已启动"} · ${elapsed}` : "等待提交 Brief"}</small></span><div className="ring" style={{"--progress":`${percent * 3.6}deg`} as React.CSSProperties}>{percent}</div></div></header>;
}

function StepNav({ step, setStep }: { step: number; setStep: (n: number) => void }) {
  return <aside className="step-nav"><div className="step-heading"><span>课程生成向导</span><b>9 个步骤</b></div><nav aria-label="课程生成步骤">{steps.map(([n, title, desc], index) => <button key={n} className={`${index === step ? "active" : ""} ${index < step ? "done" : ""}`} onClick={() => setStep(index)}><span className="step-num">{index < step ? <Icon name="check" size={14}/> : n}</span><span><b>{title}</b><small>{desc}</small></span>{index === step && <Icon name="chevron" size={15}/>}</button>)}</nav><div className="tip"><Icon name="spark"/><div><b>AI 小提示</b><p>信息越具体，生成的课程越贴近你的真实培训场景。</p></div></div></aside>;
}

function SectionTitle({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return <div className="section-title"><span>{eyebrow}</span><h1>{title}</h1><p>{desc}</p></div>;
}

function BriefStep({ onSubmit, pending, error }: { onSubmit: (brief: CourseBriefInput) => Promise<void>; pending: boolean; error: string }) {
  const [saved, setSaved] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(20);
  return <div className="content-narrow"><SectionTitle eyebrow="STEP 02 · TRAINING BRIEF" title="先把这堂课说清楚" desc="确认信息后会创建真实项目并启动生成任务；演示模式则只在当前浏览器会话中模拟。"/>
    <div className="insight"><span><Icon name="spark"/></span><div><b>AI 已识别培训意图</b><p>这是一门面向日常办公场景的全员安全意识课程，重点帮助员工判断生成式 AI 工具中的数据输入边界。</p></div><button>查看依据</button></div>
    <form className="brief-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); setSaved(false); void onSubmit({ title: String(data.get("title") ?? ""), idea: String(data.get("idea") ?? ""), audience: String(data.get("audience") ?? ""), durationMinutes, background: String(data.get("background") ?? ""), objectives: ["能判断哪些信息不可输入外部 AI 工具", "遇到不确定情况时知道如何查询与求助"] }).then(() => setSaved(true)).catch(() => undefined); }}>
      <div className="field full"><label htmlFor="course-title">课程名称 <em>必填</em></label><input id="course-title" name="title" required maxLength={160} defaultValue="生成式 AI 安全使用指南"/></div>
      <input type="hidden" name="idea" value="给全体员工做一堂生成式 AI 安全培训，结合真实办公场景，重点讲清楚哪些数据不能输入外部 AI 工具。"/>
      <div className="field"><label htmlFor="audience">培训受众</label><select id="audience" name="audience" defaultValue="全体员工"><option>全体员工</option><option>新员工</option><option>研发团队</option><option>管理者</option></select><small>预计覆盖 8,000–10,000 人</small></div>
      <div className="field"><label id="duration-label">目标时长</label><div className="segmented" role="group" aria-labelledby="duration-label">{[10, 20, 30, 45].map((value) => <button key={value} type="button" className={durationMinutes === value ? "selected" : ""} aria-pressed={durationMinutes === value} onClick={() => setDurationMinutes(value)}>{value} 分钟</button>)}</div></div>
      <div className="field"><label htmlFor="scene">使用场景</label><select id="scene"><option>年度全员安全必修课</option><option>新员工入职培训</option><option>专项安全宣导</option></select></div>
      <div className="field"><label htmlFor="structure">教学结构</label><select id="structure"><option>事件故事型 · 推荐</option><option>风险场景型</option><option>制度解读型</option><option>实操演练型</option></select></div>
      <div className="field full"><label htmlFor="background">培训背景</label><textarea id="background" name="background" rows={4} maxLength={5000} defaultValue="随着生成式 AI 工具在日常工作中的使用增加，员工对可输入信息边界的理解不一致。近期内部自查发现，部分同学曾将未公开业务数据输入外部 AI 服务，需要通过真实场景建立统一判断标准。"/></div>
      <div className="field full"><label>培训目标</label><div className="goals"><div><Icon name="target"/><span><b>识别风险</b><small>能判断哪些信息不可输入外部 AI 工具</small></span><button type="button">×</button></div><div><Icon name="shield"/><span><b>正确行动</b><small>遇到不确定情况时，知道如何查询与求助</small></span><button type="button">×</button></div><button type="button" className="add-goal"><Icon name="plus"/>添加目标</button></div></div>
      {error && <div className="form-error" role="alert"><b>无法启动生成</b><span>{error}</span></div>}
      <div className="form-actions"><span>{saved ? <><Icon name="check"/> 项目已创建，任务已启动</> : "提交后将开始九阶段生成"}</span><button className="secondary" type="button">保存草稿</button><button className="primary" type="submit" disabled={pending}>{pending ? "正在创建…" : "创建并开始生成"} <Icon name="arrow"/></button></div>
    </form>
  </div>;
}

function MaterialStep({ research = false }: { research?: boolean }) {
  const sources = [
    ["内部制度", "《生成式 AI 工具安全使用规范》", "已解析 · 24 条规则", "verified"],
    ["权威指南", "OWASP Top 10 for LLM Applications", "已引用 · 6 个要点", "verified"],
    ["行业案例", "员工使用公开 AI 服务导致敏感数据暴露", "已核验 · 3 个来源", "verified"],
    ["待确认", "国内互联网公司生成式 AI 使用实践", "2 条信息存在口径差异", "warning"],
  ];
  return <div className="content-wide"><SectionTitle eyebrow={research ? "STEP 04 · RESEARCH" : "STEP 05 · COURSE MATERIAL"} title={research ? "让每个事实都有出处" : "把研究变成可讲的一堂课"} desc={research ? "AI 正在按主题检索、交叉核验并整理可信证据。你可以随时查看来源与冲突项。" : "基础材料已由制度、研究结果和培训目标共同生成，可直接修改章节结构与关键表述。"}/>
    <div className="research-summary"><div><span className="large-ring">{research ? "76" : "92"}<small>%</small></span><p><b>{research ? "研究完成度" : "材料完整度"}</b><small>{research ? "14 / 18 个主题已完成" : "目标覆盖 4/4 · 事实可追溯"}</small></p></div><div className="metric"><b>{research ? "36" : "6"}</b><span>{research ? "可信来源" : "课程章节"}</span></div><div className="metric"><b>{research ? "4" : "18"}</b><span>{research ? "事实冲突" : "知识要点"}</span></div><div className="metric"><b>{research ? "08:42" : "3"}</b><span>{research ? "已用时间" : "互动练习"}</span></div></div>
    {research ? <div className="source-list"><div className="list-head"><h2>实时研究记录</h2><span className="live"><i/> 检索进行中</span></div>{sources.map(([kind,title,meta,state]) => <div className="source-row" key={title}><span className={`source-icon ${state}`}><Icon name={state === "warning" ? "bell" : "check"}/></span><div><em>{kind}</em><b>{title}</b><small>{meta}</small></div><button>查看证据 <Icon name="chevron"/></button></div>)}</div> : <MaterialEditor/>}
  </div>;
}

function MaterialEditor() {
  const chapters = ["01  为什么现在必须谈 AI 安全", "02  一次看似普通的提问", "03  数据边界：什么不能输入", "04  四步安全判断法", "05  高频办公场景实战", "06  总结与行动清单"];
  const [selected, setSelected] = useState(2);
  return <div className="material-editor"><aside><div><b>课程章节</b><button><Icon name="plus"/></button></div>{chapters.map((item,index)=><button key={item} className={selected===index?"active":""} onClick={()=>setSelected(index)}><span>{item}</span><small>{index===2?"4 个知识点":"3 个知识点"}</small></button>)}</aside><article><div className="editor-toolbar"><button>H2</button><button><b>B</b></button><button><i>I</i></button><span/><button><Icon name="wand"/> AI 优化</button></div><span className="chapter-tag">CHAPTER 03</span><h2 contentEditable suppressContentEditableWarning>数据边界：什么不能输入 AI</h2><p contentEditable suppressContentEditableWarning>判断是否可以把信息输入生成式 AI 工具，关键不在于“这段文字看起来是否敏感”，而在于它的<strong>分类等级、公开状态与使用授权</strong>。</p><div className="callout"><Icon name="shield"/><p><b>核心判断原则</b><br/>任何未公开、受访问控制或包含个人信息的数据，在未获得明确授权前，都不应输入外部 AI 服务。</p></div><h3>四类高风险信息</h3><div className="risk-grid"><div><span>01</span><b>未公开业务数据</b><small>经营数据、产品规划、内部分析</small></div><div><span>02</span><b>源代码与配置</b><small>内部代码、密钥、系统配置</small></div><div><span>03</span><b>用户与员工信息</b><small>账号、联系方式、行为数据</small></div><div><span>04</span><b>安全与漏洞信息</b><small>漏洞细节、处置记录、架构信息</small></div></div><footer><span><Icon name="check"/> 4 条内容均已关联来源</span><button><Icon name="spark"/> 让 AI 改写这一节</button></footer></article></div>;
}

function DesignStep() {
  const [choice,setChoice]=useState(0);
  const designs=[{name:"信号边界",tag:"编辑推荐",desc:"高对比黑绿视觉，强调风险信号与行动边界",style:"signal"},{name:"透明协议",tag:"清晰理性",desc:"网格化信息设计，适合制度与方法论讲解",style:"protocol"},{name:"故障现场",tag:"故事沉浸",desc:"以事件现场为线索，带来更强的叙事张力",style:"incident"}];
  return <div className="content-wide"><SectionTitle eyebrow="STEP 06 · ART DIRECTION" title="选择这堂课的视觉语言" desc="AI 根据品牌风格、受众与课程内容生成了三套真实样稿。选择一套后，将据此生成全部页面。"/><div className="design-grid">{designs.map((d,index)=><button key={d.name} onClick={()=>setChoice(index)} className={`design-card ${choice===index?"selected":""}`}><div className={`design-preview ${d.style}`}><span>SECURITY / 2026</span><h3>{index===0?<>别让一次<br/><em>随手粘贴</em><br/>越过边界</>:index===1?<>你的每一次输入<br/>都有一条<strong>安全边界</strong></>:<>这是一封<br/>不该被发送的<br/><strong>提问</strong></>}</h3><i/><small>GENERATIVE AI SAFETY</small></div><div className="design-meta"><span><b>{d.name}</b><em>{d.tag}</em></span><p>{d.desc}</p><footer><i className="swatch one"/><i className="swatch two"/><i className="swatch three"/>{choice===index&&<strong><Icon name="check"/> 已选择</strong>}</footer></div></button>)}</div><div className="style-note"><Icon name="palette"/><span><b>品牌资产已应用</b><small>企业蓝 #246BFD · HarmonyOS Sans SC · 标志安全区 24px</small></span><button>管理品牌资产</button></div></div>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "未知大小";
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
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
    <div className="artifact-dialog-meta"><span><b>类型</b>{artifact.kind}</span><span><b>修订</b>r{artifact.revision}</span><span><b>大小</b>{formatBytes(artifact.byteLength)}</span><span><b>Provider</b>{artifact.providerId}</span></div>
    <div className="artifact-frame-wrap">{(loading || (source && !frameLoaded)) && <div className="artifact-frame-state" role="status">正在加载 Reveal 交互预览…</div>}{error && <div className="artifact-frame-state error" role="alert">{error}</div>}{!loading && !error && source?.kind === "url" && <iframe title="WebPPT 安全交互预览" sandbox="allow-scripts" referrerPolicy="no-referrer" src={source.url} onLoad={() => setFrameLoaded(true)}/>} {!loading && !error && source?.kind === "html" && <iframe title="WebPPT 离线演示预览" sandbox="" referrerPolicy="no-referrer" srcDoc={hardenPreviewHtml(source.html)} onLoad={() => setFrameLoaded(true)}/>}</div>
    <footer><span><Icon name="shield"/> 脚本可运行 · 无同源权限</span><small>方向键、空格键或页面控件可翻页；讲稿备注不会显示在观众页面。</small></footer>
  </section></div>;
}

function ArtifactStatus({ artifacts, loading, error, mode, onRefresh, onPreview }: { artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const reveal = artifacts.find((artifact) => artifact.kind === "reveal-html");
  return <div className={`artifact-status ${reveal ? "ready" : "waiting"}`}>
    <span className="artifact-status-icon"><Icon name={reveal ? "check" : "clock"}/></span>
    <div><b>{loading ? "正在检查 WebPPT 产物" : reveal ? `${mode === "demo" ? "演示" : "真实"} Reveal HTML 已就绪` : "尚无可预览的 Reveal HTML"}</b><small>{error || (reveal ? `r${reveal.revision} · ${formatBytes(reveal.byteLength)} · ${reveal.providerId}` : "生成完成后才能读取预览；不会以演示内容替代在线失败。")}</small></div>
    {reveal ? <button className="primary" onClick={() => onPreview(reveal)} disabled={loading}><Icon name="play"/>预览 WebPPT</button> : <button className="secondary" onClick={onRefresh} disabled={loading}>{loading ? "检查中…" : "重新检查"}</button>}
  </div>;
}

function DeckStep({ artifacts, loading, error, mode, onRefresh, onPreview }: { artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const [slide,setSlide]=useState(2);
  const slides=["封面","为什么现在必须谈 AI 安全","一次看似普通的提问","你输入的，可能不只是一段文字","四类高风险信息","四步安全判断法"];
  return <div className="deck-workspace"><aside className="slides-panel"><header><b>页面</b><span>设计草稿</span><button><Icon name="plus"/></button></header>{slides.map((title,index)=><button key={title} className={slide===index?"active":""} onClick={()=>setSlide(index)}><span>{String(index+1).padStart(2,"0")}</span><div className={`thumb thumb-${index}`}><small>{index===2?"一次看似普通的":"SECURITY"}</small><b>{index===2?"提问":"AI 安全"}</b></div><p>{title}</p></button>)}</aside><section className="stage"><div className="stage-bar"><span>页面设计草稿 {slide+1} / {slides.length}</span><div><button disabled>50%</button><button disabled><Icon name="play"/> 草稿演示</button></div></div><ArtifactStatus artifacts={artifacts} loading={loading} error={error} mode={mode} onRefresh={onRefresh} onPreview={onPreview}/><div className="slide-canvas"><span className="deck-kicker">DESIGN DRAFT · 非服务器产物预览</span><h1>一次看似普通的<br/><em>提问</em></h1><div className="chat-demo"><div className="chat-user"><span className="bot-avatar">AI</span><p>我可以帮你分析，<br/>请把数据粘贴到这里。</p></div><div className="chat-input">请分析这份用户流失明细…<span>↵</span></div><i className="data-chip one">customer_id</i><i className="data-chip two">手机号</i><i className="data-chip three">订单金额</i></div><footer><span>03</span><i/><small>GENERATIVE AI SAFETY</small></footer></div><div className="speaker-notes"><header><b><Icon name="mic"/> 讲稿草稿</b><span>尚未 TTS 实测</span><button disabled>展开</button></header><p>想象一下这个场景：你正在分析一份用户流失数据，为了更快找到原因，你打开了一个常用的 AI 工具……</p></div></section><aside className="ai-panel"><header><span><Icon name="spark"/> AI 设计助手</span><button><Icon name="more"/></button></header><div className="ai-thread"><div className="ai-msg"><span><Icon name="spark"/></span><p>当前编辑器仍是设计草稿。请使用中间的“预览 WebPPT”查看服务器生成的 Reveal HTML。</p></div></div><div className="ai-compose"><textarea aria-label="向 AI 描述修改" placeholder="AI 迭代尚未接入" disabled/><footer><span>后续批次开放</span><button aria-label="发送" disabled><Icon name="arrow"/></button></footer></div></aside></div>;
}

function NarrationStep() {
  const rows=[{n:1,title:"封面：守住数据边界",time:"00:22",state:"ok"},{n:2,title:"为什么现在必须谈 AI 安全",time:"01:18",state:"ok"},{n:3,title:"一次看似普通的提问",time:"01:12",state:"ok"},{n:4,title:"你输入的，可能不只是一段文字",time:"01:46",state:"warn"},{n:5,title:"四类高风险信息",time:"01:26",state:"ok"}];
  return <div className="content-wide"><SectionTitle eyebrow="STEP 08 · NARRATION & TIMING" title="让讲稿与时间刚刚好" desc="每页讲稿已按培训目标生成，并使用实际语音时长校准。当前总时长与目标相差 24 秒。"/><div className="timing-overview"><div className="timeline-ring"><span><b>19:36</b><small>目标 20:00</small></span></div><div><b>时长匹配度</b><h2>98%</h2><p><span className="good"><Icon name="check"/> 14 页符合节奏</span><span className="warning-dot">1 页建议压缩</span></p></div><div className="voice"><span className="voice-avatar">周</span><p><b>周晓 · 沉稳清晰</b><small>中文普通话 · 语速 1.0×</small></p><button><Icon name="play"/> 试听</button></div></div><div className="narration-table"><header><span>页面与讲稿</span><span>字数</span><span>实测时长</span><span>状态</span><span/></header>{rows.map(row=><div key={row.n}><span><i>{String(row.n).padStart(2,"0")}</i><b>{row.title}</b></span><span>{row.n===4?"382":"246"}</span><span>{row.time}</span><span className={row.state}>{row.state==="ok"?<><Icon name="check"/> 节奏合适</>:<>超出 16 秒</>}</span><button><Icon name="chevron"/></button></div>)}</div><div className="timing-actions"><button className="secondary"><Icon name="mic"/> 批量试听</button><button className="primary">自动校准时长 <Icon name="wand"/></button></div></div>;
}

function VideoStep({ artifacts, loading, error, mode, onRefresh, onPreview }: { artifacts: CourseArtifact[]; loading: boolean; error: string; mode: "online" | "demo"; onRefresh: () => void; onPreview: (artifact: CourseArtifact) => void }) {
  const hasReveal = artifacts.some((artifact) => artifact.kind === "reveal-html");
  return <div className="content-narrow video-complete"><span className="complete-badge"><Icon name="check" size={28}/></span><span className="eyebrow">WORKFLOW CHECKPOINT COMPLETE</span><h1>九阶段流程演练已完成</h1><p>{hasReveal ? "Reveal HTML 已生成并可安全预览；" : "任务状态、权限与进度链路已经验证；"}当前仍没有真实 TTS 音频或 MP4 视频。</p><ArtifactStatus artifacts={artifacts} loading={loading} error={error} mode={mode} onRefresh={onRefresh} onPreview={onPreview}/><div className="video-player"><div className="video-frame"><span>COURSEFORGE · INTERNAL ALPHA</span><h2>音视频产物<br/><em>等待 TTS 与渲染</em><br/>Provider 接入</h2><button aria-label="视频播放尚不可用" disabled><Icon name="play" size={26}/></button><footer>非视频占位画面 <small>NO AUDIO / NO MP4</small></footer></div></div><div className="quality-row"><div><Icon name="check"/><span><b>9 / 9</b><small>工作流阶段完成</small></span></div><div><Icon name="check"/><span><b>{artifacts.length}</b><small>当前可见产物</small></span></div><div><Icon name="clock"/><span><b>待接入</b><small>TTS 与视频渲染</small></span></div><div><Icon name="shield"/><span><b>受保护</b><small>登录和项目权限</small></span></div></div><div className="delivery-actions"><button className="secondary" disabled><Icon name="mic"/> TTS 尚未生成</button><button className="primary" disabled><Icon name="video"/> MP4 尚未生成</button></div><button className="text-button">查看工作流事件 <Icon name="chevron"/></button></div>;
}

function SimpleStep({ step }: { step:number }) {
  const intake=step===0;
  return <div className="content-narrow"><SectionTitle eyebrow={`STEP 0${step+1} · ${intake?"SOURCE INTAKE":"DATA POLICY"}`} title={intake?"从已有的任何内容开始":"确认这次生成的数据边界"} desc={intake?"一个想法、一份制度或已有 PPT 都可以。AI 会识别内容并告诉你还缺什么。":"选择允许使用的模型与联网范围。所有调用都会记录在本项目的审计轨迹中。"}/>{intake?<><div className="upload-zone"><span><Icon name="upload" size={26}/></span><h3>拖入 PDF、Word 或 PPTX</h3><p>单个文件不超过 100 MB，最多上传 20 个</p><button className="secondary">选择文件</button></div><div className="or"><span/>或者<span/></div><div className="idea-box"><label htmlFor="idea">描述你的培训点子</label><textarea id="idea" rows={5} defaultValue="给全体员工做一堂 20 分钟的生成式 AI 安全培训，结合近期真实办公场景，重点讲清楚哪些数据不能输入外部 AI 工具。"/><footer><button><Icon name="spark"/> 帮我补充这个想法</button><span>72 / 2,000</span></footer></div></>:<div className="policy-grid"><button className="selected"><span><Icon name="shield"/></span><b>受控联网 · 推荐</b><p>允许公开网页搜索；内部文档仅发送给已批准的企业模型服务。</p><footer><Icon name="check"/> 已选择</footer></button><button><span><Icon name="search"/></span><b>仅公开信息</b><p>内部文档不离开本地，只使用标题和脱敏关键词进行公开检索。</p></button><button><span><Icon name="folder"/></span><b>完全离线</b><p>只分析已上传材料，不调用搜索或外部模型服务。</p></button><div className="provider-note"><b>本次使用的能力</b><span>文本模型 <em>企业兼容接口</em></span><span>多模态模型 <em>Qwen 系列</em></span><span>公开搜索 <em>Agent-Reach</em></span></div></div>}</div>;
}

const stageToStep: Record<string, number> = { intake: 0, research: 3, material: 4, deck: 6, narration: 7, tts: 7, render: 8, qa: 8, publish: 8 };

function Wizard({ client, onExit }: { client: CourseClient; onExit: () => void }) {
  const [step,setStep]=useState(1);
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
  useEffect(() => () => { stopWatching?.(); }, [stopWatching]);
  const submitBrief = async (brief: CourseBriefInput) => {
    setPending(true); setError(""); stopWatching?.();
    try {
      const project = await client.createProject(brief);
      setProjectId(project.id);
      setArtifacts([]);
      const started = await client.startGeneration(project.id);
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
    if (projectId && (step >= 6 || job?.status === "completed")) void refreshArtifacts();
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
  const content=useMemo(()=>{if(step===0||step===2)return <SimpleStep step={step}/>;if(step===1)return <BriefStep onSubmit={submitBrief} pending={pending} error={error}/>;if(step===3)return <MaterialStep research/>;if(step===4)return <MaterialStep/>;if(step===5)return <DesignStep/>;if(step===6)return <DeckStep {...artifactProps}/>;if(step===7)return <NarrationStep/>;return <VideoStep {...artifactProps}/>;},[step, pending, error, artifacts, artifactsLoading, artifactError, client.mode]);
  return <div className="wizard-shell"><ProgressHeader step={step} onExit={onExit} job={job} latestEvent={latestEvent} mode={client.mode}/><StepNav step={step} setStep={setStep}/><main className={step===6?"deck-main":"wizard-main"}>{error && step !== 1 && <div className="error-banner compact" role="alert"><span><b>任务状态提示</b>{error}</span></div>}{content}</main>{step!==6&&<div className="step-controls"><button className="secondary" onClick={()=>setStep(Math.max(0,step-1))} disabled={step===0}>上一步</button><span>{job ? `生成 ${job.progressPercent}% · ${job.status}` : `步骤 ${step+1} / 9`}</span><button className="primary" onClick={()=>setStep(Math.min(8,step+1))} disabled={step===8 || pending}>保存并继续 <Icon name="arrow"/></button></div>}{previewArtifact && <ArtifactPreviewDialog artifact={previewArtifact} source={previewSource} mode={client.mode} loading={previewLoading} error={previewError} onClose={closePreview}/>}</div>;
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
  const [view,setView]=useState<"dashboard"|"wizard">("dashboard");
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
  return view==="dashboard"?<Dashboard client={client} user={user} onLogout={logout} onOpen={()=>setView("wizard")}/>:<Wizard client={client} onExit={()=>setView("dashboard")}/>;
}
