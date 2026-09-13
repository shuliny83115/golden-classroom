(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const cfg = window.GOLDEN_CLASSROOM_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
  const roles = {admin:'管理員',teacher:'老師',student:'學生'};
  const statuses = {pending:'待審核',approved:'已核准',rejected:'未通過'};
  let dashboard=null, activeView='schedule', refreshTimer=null, refreshBusy=null, confirmation=null, timeOffset=0, authEpoch=0;
  const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateKey = value => new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10);
  const time = value => new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
  const now = () => Date.now()+timeOffset;
  const errors = {UNFINISHED_LESSONS:'仍有未結束課程，請先取消或等課程結束後再停用。',STALE_COURSE:'課程已被修改或刪除，請重新開啟課程設定。',INVALID_COURSE:'請選擇管理員已建立的課程名稱（1–100 字）。',COURSE_EXISTS:'這個課程名稱已經存在。',STALE_PROFILE:'資料已被更新，請關閉視窗並重新整理後再編輯。',INVALID_NAME:'姓名需要 1 至 100 個字元。',ADMIN_REQUIRED:'只有管理員可以執行此操作。',APPLICATION_NOT_PENDING:'這筆申請已經處理過，請重新整理。',ROOM_REQUIRED:'請先選擇固定教室。',ROOM_NOT_FOUND:'找不到這間教室。',ROOM_ALREADY_ASSIGNED:'這間教室已指派給其他老師。',TEACHER_REQUIRED:'需要已核准且已指派教室的老師帳號。',TEACHER_NOT_READY:'所選老師尚未核准或沒有固定教室。',STUDENT_NOT_ASSIGNED:'只能替已分配給你的學生排課。',INVALID_TIME:'課堂須在半點開始，固定 55 分鐘，不可排過去的時間。',INVALID_TITLE:'請填寫課程名稱，並確認備註長度。',LESSON_CONFLICT:'這個時段已有課程，老師、學生或教室發生衝堂。',LESSON_NOT_OPEN:'這堂課尚未開始、已結束或已取消。',LESSON_NOT_CANCELLABLE:'這堂課已取消或已結束，請重新整理。',PROFILE_NOT_FOUND:'尚無平台個人資料，請聯絡管理員。'};
  function friendly(error){const m=String(error?.message||error);return Object.entries(errors).find(([key])=>m.includes(key))?.[1]||'操作未完成，請稍後再試；若持續發生請聯絡管理員。';}
  function message(id,text,success=false){$(id).textContent=text;$(id).classList.toggle('success',success);}
  async function rpc(name,args={}){const {data,error}=await sb.rpc(name,args);if(error)throw error;return data;}
  async function busy(form,fn,errorId){const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();}catch(e){message(errorId,friendly(e));}finally{buttons.forEach(b=>b.disabled=false);}}
  async function accountEmail(username){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(username.trim().toLowerCase()));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')+'@goldenclassroom.test';}
  function showAuth(){authEpoch++;clearInterval(refreshTimer);refreshTimer=null;dashboard=null;activeView='schedule';confirmation=null;$('portalView').hidden=true;$('authView').hidden=false;document.querySelectorAll('dialog[open]').forEach(d=>d.close());['applicationList','peopleRows','lessonList','stats','auditList','courseList'].forEach(id=>$(id).replaceChildren());$('personFilter').innerHTML='<option value="">全部師生</option>';['schedule','applications','people','audit','courses'].forEach(v=>$(v+'Panel').hidden=v!=='schedule');document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view==='schedule'));message('portalMessage','');}
  function switchAuth(register){$('loginForm').hidden=register;$('registerForm').hidden=!register;message('authMessage','');}
  $('showRegister').onclick=()=>switchAuth(true);$('backToLogin').onclick=()=>switchAuth(false);
  $('registerForm').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;busy(form,async()=>{
    message('authMessage','');const fields=Object.fromEntries(new FormData(form));
    if(!/[A-Za-z]/.test(fields.username)){message('authMessage','帳號至少需要 6 個字元，且必須包含英文。');return;}
    if(fields.password!==fields.confirm){message('authMessage','兩次輸入的密碼不一致。');return;}
    const {data,error}=await sb.functions.invoke('register-application',{body:{username:fields.username.trim(),display_name:fields.display_name.trim(),password:fields.password,role:fields.role}});
    if(error){let body;try{body=await error.context?.json();}catch{}message('authMessage',body?.error||'註冊服務暫時無法使用，請稍後再試。');return;}
    if(!data?.ok){message('authMessage',data?.error||'申請未完成，請稍後再試。');return;}
    form.reset();switchAuth(false);$('account').value=fields.username.trim();message('authMessage','註冊申請已送出，請等待管理員審核。',true);
  },'authMessage');});
  $('loginForm').addEventListener('submit',event=>{event.preventDefault();busy(event.currentTarget,async()=>{
    message('authMessage','');const account=$('account').value.trim();const password=$('password').value;
    let result=await sb.auth.signInWithPassword({email:await accountEmail(account),password});
    // Only these two pre-existing test accounts use legacy email mapping.
    if(result.error && ['teacher01','student01'].includes(account.toLowerCase()))result=await sb.auth.signInWithPassword({email:account.toLowerCase()+'@goldenclassroom.test',password});
    if(result.error){message('authMessage','帳號或密碼錯誤，請確認後再試。');return;}
    $('password').value='';await loadDashboard();
  },'authMessage');});
  $('logout').onclick=async()=>{await sb.auth.signOut();showAuth();message('authMessage','已登出。',true);};
  async function loadDashboard(){
    const epoch=authEpoch;if(refreshBusy===epoch)return;refreshBusy=epoch;
    try{const result=await rpc('gc_dashboard');if(epoch!==authEpoch)return;dashboard=result;timeOffset=new Date(result.server_now).getTime()-Date.now();
      if(result.profile.status!=='approved'){const status=result.profile.status;await sb.auth.signOut();showAuth();message('authMessage',status==='pending'?'帳號尚未通過管理員審核，請等待通知。':'這次申請未通過審核，請聯絡管理員。');return;}
      $('authView').hidden=true;$('portalView').hidden=false;renderDashboard();
      if(!refreshTimer)refreshTimer=setInterval(()=>{if(!document.hidden&&!document.querySelector('dialog[open]')&&activeView!=='applications')loadDashboard().catch(()=>{});},30000);
    }catch(error){if(epoch===authEpoch)message(dashboard?'portalMessage':'authMessage',friendly(error));throw error;}finally{if(refreshBusy===epoch)refreshBusy=null;}
  }
  function stats(items){$('stats').innerHTML=items.map(([label,value,note])=>`<article class="stat"><span class="stat-title">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`).join('');}
  function renderDashboard(){
    const {profile:p,people=[],lessons=[],students=[]}=dashboard;const admin=p.role==='admin';document.querySelector('[data-view="completed"]').hidden=admin;
    $('userName').textContent=p.display_name;$('roleBadge').textContent=roles[p.role];
    $('portalEyebrow').textContent=admin?'CLASSROOM MANAGEMENT':p.role==='teacher'?'TEACHER WORKSPACE':'MY LEARNING JOURNEY';
    $('portalTitle').textContent=admin?'教室管理中心':`${p.display_name}，歡迎回來`;
    $('portalSubtitle').textContent=admin?'審核申請、連結師生，掌握每一堂課的安排。':p.role==='teacher'?'安排課程，陪伴每位學生的下一步。':'你的下一次探索，就從這裡開始。';
    $('newLesson').hidden=p.role!=='teacher';$('personFilterWrap').hidden=!admin;
    document.querySelector('[data-view="schedule"]').textContent=admin?'全體課表':'我的課表';
    document.querySelectorAll('[data-view="applications"],[data-view="people"],[data-view="audit"],[data-view="courses"]').forEach(b=>b.hidden=!admin);
    const upcoming=lessons.filter(l=>l.status==='scheduled'&&new Date(l.ends_at).getTime()>now());
    const today=upcoming.filter(l=>dateKey(l.starts_at)===dateKey(now())).length;
    const pending=people.filter(p=>p.status==='pending');$('pendingCount').textContent=pending.length;
    if(admin)stats([['待審核申請',pending.length,'等你確認的加入申請'],['今日課堂',today,'全體老師的課程安排'],['已核准師生',people.filter(p=>p.status==='approved'&&p.role!=='admin').length,'一起學習的夥伴']]);
    else stats([['今日課堂',today,'準備好迎接今天的學習'],['即將到來',upcoming.length,'已安排的課程'],[p.role==='teacher'?'我的學生':'下堂課日期',p.role==='teacher'?students.length:(upcoming[0]?dateKey(upcoming[0].starts_at).slice(5).replace('-',' / '):'—'),p.role==='teacher'?'由管理員指派的學生':'期待下一次見面']]);
    if(!$('fromDate').value){$('fromDate').value=dateKey(now());$('toDate').value=dateKey(now()+6*86400000);}
    if(admin){const selected=$('personFilter').value;$('personFilter').innerHTML='<option value="">全部師生</option>'+people.filter(p=>p.role!=='admin'&&p.status==='approved').map(p=>`<option value="${esc(p.id)}">${esc(p.display_name)} · ${roles[p.role]}</option>`).join('');$('personFilter').value=selected;renderApplications();renderPeople();}
    renderLessons();
  }
  function renderLessons(){if(!dashboard)return;const person=$('personFilter').value;const from=$('fromDate').value,to=$('toDate').value;
    document.querySelector('#schedulePanel h2').textContent=activeView==='completed'?'已完成課程':'課程安排';
    $('fromDate').closest('label').hidden=activeView==='completed';$('toDate').closest('label').hidden=activeView==='completed';
    if(activeView!=='completed'&&from&&to&&from>to){$('lessonList').innerHTML='<div class="empty"><strong>日期範圍有誤</strong><p>結束日期需晚於或等於起始日期。</p></div>';return;}
    const history=activeView==='completed'; const cutoff=new Date(now()+8*3600000);const day=cutoff.getUTCDate();cutoff.setUTCDate(1);cutoff.setUTCMonth(cutoff.getUTCMonth()-3);const last=new Date(Date.UTC(cutoff.getUTCFullYear(),cutoff.getUTCMonth()+1,0)).getUTCDate();cutoff.setUTCDate(Math.min(day,last));const cutoffMs=cutoff.getTime()-8*3600000;
    const lessons=(dashboard.lessons||[]).filter(l=>{const ended=l.session_ended_at?new Date(l.session_ended_at).getTime():new Date(l.ends_at).getTime()+300000;return dashboard.profile.role==='admin'||(history?l.status==='scheduled'&&ended<=now()&&ended>=cutoffMs:l.status==='scheduled'&&ended>now());}).filter(l=>(history||!from||dateKey(l.starts_at)>=from)&&(history||!to||dateKey(l.starts_at)<=to)&&(!person||[l.teacher_id,l.student_id].includes(person)));
    $('lessonList').innerHTML=lessons.length?lessons.map(l=>{const date=dateKey(l.starts_at);const start=new Date(l.starts_at).getTime(),end=new Date(l.ends_at).getTime();const live=l.status==='scheduled'&&!l.session_ended_at&&now()>=start-300000&&now()<end+300000;const state=l.status==='cancelled'?'已取消':l.session_ended_at||now()>=end+300000?'已結束':now()>=end?'課後交接':now()>=start?'上課中':live?'可報到':'即將開始';const admin=dashboard.profile.role==='admin';
      return `<article class="lesson-card"><div class="date-tile"><small>${date.slice(0,4)} / ${date.slice(5,7)}</small><strong>${date.slice(8)}</strong><small>${new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',weekday:'short'}).format(new Date(l.starts_at))}</small></div><div class="lesson-info"><span class="time">${time(l.starts_at)} — ${time(l.ends_at)}</span><h3>${esc(l.title)}</h3><div class="lesson-meta"><span>老師 · ${esc(l.teacher_name)}</span><span>學生 · ${esc(l.student_name)}</span><span>${esc(l.room_name)}</span></div>${l.notes?`<p class="lesson-note">${esc(l.notes)}</p>`:''}${l.status==='cancelled'&&l.cancellation_reason?`<p class="lesson-note">取消原因：${esc(l.cancellation_reason)}</p>`:''}</div><div class="lesson-actions"><span class="badge ${l.status==='cancelled'?'cancelled':''}">${state}</span>${!admin&&live?`<button class="primary" data-join="${esc(l.id)}">進入教室 →</button>`:''}${admin&&l.status==='scheduled'&&end>now()?`<button class="text-button" data-cancel="${esc(l.id)}">取消課堂</button>`:''}</div></article>`;}).join(''):'<div class="empty"><strong>這段時間還沒有課程</strong><p>可以調整日期範圍，查看其他課堂安排。</p></div>';
  }
  setInterval(()=>{if(dashboard&&!document.hidden&&['schedule','completed'].includes(activeView)&&!document.querySelector('dialog[open]'))renderLessons();},1000);
  function renderApplications(){const pending=dashboard.people.filter(p=>p.status==='pending');$('applicationList').innerHTML=pending.length?pending.map(p=>{
    const options=p.role==='teacher'?dashboard.rooms.filter(r=>!dashboard.people.some(t=>t.role==='teacher'&&t.status==='approved'&&t.fixed_room_id===r.id)).map(r=>[r.id,r.room_name]):dashboard.people.filter(t=>t.role==='teacher'&&t.status==='approved'&&t.fixed_room_id).map(t=>[t.id,t.display_name]);
    return `<article class="application"><span class="badge pending">申請${roles[p.role]}</span><h3>${esc(p.display_name)}</h3><div class="username">${esc(p.username)}</div><p class="muted small">申請日期 ${dateKey(p.created_at)}</p><label>${p.role==='teacher'?'固定教室':'授課老師'}<select id="assign-${esc(p.id)}"><option value="">${options.length?'請選擇':'目前沒有可用選項'}</option>${options.map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('')}</select></label><div class="review-actions"><button class="primary" data-review="${esc(p.id)}" data-approve="true" ${options.length?'':'disabled'}>核准申請</button><button class="subtle" data-review="${esc(p.id)}" data-approve="false">拒絕</button></div></article>`;}).join(''):'<div class="empty"><strong>目前沒有待審核申請</strong><p>新的註冊申請會顯示在這裡。</p></div>';}
  function renderPeople(){const {people,rooms}=dashboard;$('peopleRows').innerHTML=people.filter(p=>!p.disabled_at).map(p=>`<tr><td>${esc(p.display_name)}<small>${esc(p.username||'既有測試帳號')}</small></td><td>${roles[p.role]}</td><td><span class="badge ${esc(p.status)}">${statuses[p.status]}</span></td><td>${esc(p.role==='teacher'?rooms.find(r=>r.id===p.fixed_room_id)?.room_name||'尚未指派':p.role==='student'?people.find(t=>t.id===p.assigned_teacher_id)?.display_name||'尚未指派':'—')}</td><td>${p.role!=='admin'?`<button class="subtle" data-edit="${esc(p.id)}" aria-label="編輯 ${esc(p.display_name)}">編輯</button><button class="subtle" data-disable="${esc(p.id)}">刪除</button>`:''}</td></tr>`).join('');}
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{activeView=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));['schedule','applications','people','audit','courses'].forEach(v=>$(v+'Panel').hidden=v!==(activeView==='completed'?'schedule':activeView));renderLessons();message('portalMessage','');if(activeView==='courses')loadCourses().catch(e=>message('courseMessage',friendly(e)));if(activeView==='audit')loadAudit().catch(()=>{});if(activeView==='applications')loadDashboard().catch(()=>{});});
  ['fromDate','toDate','personFilter'].forEach(id=>$(id).addEventListener('change',renderLessons));
  $('refresh').onclick=()=>loadDashboard().then(()=>message('portalMessage','已更新課表。',true)).catch(()=>{});
  $('newLesson').onclick=async()=>{try{const epoch=authEpoch;const courses=await rpc('gc_courses_list');if(epoch!==authEpoch||dashboard?.profile.role!=='teacher')return;$('bookingCourse').innerHTML='<option value="">請選擇課程</option>'+courses.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');const form=$('bookingForm');form.reset();form.elements.date.value=dateKey(now());form.elements.date.min=dateKey(now());$('bookingStudent').innerHTML='<option value="">請選擇學生</option>'+(dashboard.students||[]).map(s=>`<option value="${esc(s.id)}">${esc(s.display_name)}</option>`).join('');message('bookingMessage',dashboard.students?.length?'':'尚未有指派給你的學生，請聯絡管理員。');$('bookingDialog').showModal();}catch(e){message('portalMessage',friendly(e));}};
  $('bookingForm').addEventListener('submit',event=>{event.preventDefault();busy(event.currentTarget,async()=>{message('bookingMessage','');const f=Object.fromEntries(new FormData(event.currentTarget));await rpc('gc_book',{p_student:f.student,p_title:f.title,p_starts:new Date(`${f.date}T${f.start}:00+08:00`).toISOString(),p_ends:new Date(new Date(`${f.date}T${f.start}:00+08:00`).getTime()+55*60000).toISOString(),p_notes:f.notes});$('bookingDialog').close();$('fromDate').value=f.date;$('toDate').value=dateKey(new Date(`${f.date}T00:00:00+08:00`).getTime()+6*86400000);await loadDashboard();message('portalMessage','課堂已建立，學生也能在課表中查看。',true);},'bookingMessage');});
  function confirmAction(title,description,fn,reason=false){confirmation=fn;$('confirmTitle').textContent=title;$('confirmDescription').textContent=description;$('reasonWrap').hidden=!reason;$('cancelReason').value='';message('confirmMessage','');$('confirmDialog').showModal();}
  $('applicationList').onclick=event=>{const b=event.target.closest('[data-review]');if(!b)return;const p=dashboard.people.find(p=>p.id===b.dataset.review);const approve=b.dataset.approve==='true';const assignment=$('assign-'+p.id).value;if(approve&&!assignment){message('portalMessage',p.role==='teacher'?'請先選擇固定教室。':'請先選擇授課老師。');return;}const selected=$('assign-'+p.id).selectedOptions[0].textContent;confirmAction(approve?'核准這筆申請？':'拒絕這筆申請？',`${p.display_name}（${p.username}）${approve?'，指派：'+selected:'，拒絕後將無法使用平台。'}`,async()=>{await rpc('gc_review',{p_user:p.id,p_approve:approve,p_room:approve&&p.role==='teacher'?assignment:null,p_teacher:approve&&p.role==='student'?assignment:null});});};
  $('lessonList').onclick=async event=>{const cancel=event.target.closest('[data-cancel]'),join=event.target.closest('[data-join]');if(cancel){const l=dashboard.lessons.find(l=>l.id===cancel.dataset.cancel);confirmAction('取消這堂課？',`${l.title} · ${l.student_name} · ${dateKey(l.starts_at)} ${time(l.starts_at)}。取消後會保留課程紀錄。`,()=>rpc('gc_cancel',{p_lesson:l.id,p_reason:$('cancelReason').value}),true);}if(join){join.disabled=true;try{location.href='classroom.html?lesson='+encodeURIComponent(join.dataset.join);}catch(error){message('portalMessage',friendly(error));join.disabled=false;}}};
  $('confirmForm').addEventListener('submit',event=>{event.preventDefault();busy(event.currentTarget,async()=>{await confirmation();$('confirmDialog').close();await loadDashboard();message('portalMessage','已完成更新。',true);},'confirmMessage');});

  let editing=null,auditCursor=null;
  $('peopleRows').onclick=event=>{const remove=event.target.closest('[data-disable]');if(remove){const p=dashboard.people.find(x=>x.id===remove.dataset.disable);confirmAction('刪除並停用帳號？',`${p.display_name}：停用後無法使用平台，保留歷史紀錄。老師的教室將釋出，學生需重新指派老師。`,()=>rpc('gc_disable_person',{p_user:p.id,p_revision:p.revision}));return;}const b=event.target.closest('[data-edit]');if(!b)return;editing=dashboard.people.find(p=>p.id===b.dataset.edit);const p=editing;
    $('editIdentity').textContent=roles[p.role]+' · '+p.username;$('editName').value=p.display_name;
    $('editAssignmentWrap').hidden=p.status!=='approved';$('editAssignment').required=p.status==='approved';
    $('editAssignmentLabel').textContent=p.role==='teacher'?'固定教室':'授課老師';
    const options=p.role==='teacher'?dashboard.rooms.filter(r=>!dashboard.people.some(t=>t.id!==p.id&&t.role==='teacher'&&t.status==='approved'&&t.fixed_room_id===r.id)).map(r=>[r.id,r.room_name]):dashboard.people.filter(t=>t.role==='teacher'&&t.status==='approved'&&t.fixed_room_id).map(t=>[t.id,t.display_name]);
    $('editAssignment').innerHTML='<option value="">請選擇</option>'+options.map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');
    $('editAssignment').value=p.fixed_room_id||p.assigned_teacher_id||'';message('editMessage','');$('editDialog').showModal();
  };
  $('editForm').onsubmit=event=>{event.preventDefault();busy(event.currentTarget,async()=>{const p=editing;await rpc('gc_edit_person',{p_user:p.id,p_name:$('editName').value,p_room:p.status==='approved'&&p.role==='teacher'?$('editAssignment').value:null,p_teacher:p.status==='approved'&&p.role==='student'?$('editAssignment').value:null,p_revision:p.revision});$('editDialog').close();await loadDashboard();message('portalMessage','師生資料已更新，並留下異動紀錄。',true);},'editMessage');};
  const auditLabels={name:'姓名',username:'帳號',role:'身分',status:'狀態',room:'教室',teacher:'授課老師'};
  function auditDetail(row){const n=row.after_data||{},b=row.before_data;
    if(n.deleted)return '課程名稱：'+n.name+'（已從排課選單刪除）';
    if(n.title)return n.title+' · '+n.teacher_name+' / '+n.student_name+' · '+n.room_name+' · '+dateKey(n.starts_at)+' '+time(n.starts_at)+'–'+time(n.ends_at)+(n.session_ended_at?' · 結束時間：'+time(n.session_ended_at):'')+(n.cancellation_reason?' · 原因：'+n.cancellation_reason:'');
    const value=v=>statuses[v]||roles[v]||v||'未指派';
    return Object.keys(auditLabels).filter(k=>!b||b[k]!==n[k]).map(k=>auditLabels[k]+'：'+(b?value(b[k])+' → ':'')+value(n[k])).join('；');
  }
  async function loadAudit(more=false){const epoch=authEpoch;$('auditMore').disabled=true;try{const rows=await rpc('gc_audit',{p_before:more?auditCursor:null});if(epoch!==authEpoch||dashboard?.profile.role!=='admin')return;if(!more)$('auditList').replaceChildren();$('auditList').insertAdjacentHTML('beforeend',rows.map(r=>`<article class="application"><span class="badge">${esc(r.action)}</span><p class="muted small">${dateKey(r.occurred_at)} ${time(r.occurred_at)} · ${esc(r.actor_name)}</p><p>${esc(auditDetail(r))}</p></article>`).join(''));if(!more&&!rows.length)$('auditList').textContent='最近三個月尚無異動紀錄。';auditCursor=rows.at(-1)?.id;$('auditMore').hidden=rows.length<100;}catch(e){message('portalMessage',friendly(e));}finally{$('auditMore').disabled=false;}}
  $('auditRefresh').onclick=()=>loadAudit();$('auditMore').onclick=()=>loadAudit(true);
  let courseItems=[],courseEditing=null;
  async function loadCourses(){const epoch=authEpoch;const courses=await rpc('gc_courses_list');if(epoch!==authEpoch||dashboard?.profile.role!=='admin')return;courseItems=courses;$('courseList').innerHTML=courses.length?courses.map(c=>`<article class="application course-row"><h3>${esc(c.name)}</h3><div class="course-actions"><button class="subtle" data-course-edit="${esc(c.id)}" aria-label="編輯 ${esc(c.name)}">編輯</button><button class="subtle" data-course-delete="${esc(c.id)}" aria-label="刪除 ${esc(c.name)}">刪除</button></div></article>`).join(''):'<p class="muted">尚無可選課程，請新增課程名稱。</p>';}
  $('courseList').onclick=event=>{const edit=event.target.closest('[data-course-edit]'),del=event.target.closest('[data-course-delete]');if(!edit&&!del)return;const c=courseItems.find(c=>c.id===(edit?.dataset.courseEdit||del.dataset.courseDelete));if(edit){courseEditing=c;$('courseEditName').value=c.name;message('courseEditMessage','');$('courseEditDialog').showModal();}else confirmAction('刪除課程名稱？',c.name+'：刪除後不再出現在新排課選單；已排課程不受影響。',async()=>{await rpc('gc_change_course',{p_id:c.id,p_expected:c.name,p_name:null,p_delete:true});await loadCourses();});};
  $('courseEditForm').onsubmit=event=>{event.preventDefault();busy(event.currentTarget,async()=>{await rpc('gc_change_course',{p_id:courseEditing.id,p_expected:courseEditing.name,p_name:$('courseEditName').value,p_delete:false});$('courseEditDialog').close();await loadCourses();message('courseMessage','課程名稱已更新，並留下異動紀錄。',true);},'courseEditMessage');};
  $('courseForm').onsubmit=event=>{event.preventDefault();busy(event.currentTarget,async()=>{await rpc('gc_add_course',{p_name:event.currentTarget.elements.courseName.value});$('courseForm').reset();await loadCourses();message('courseMessage','已新增，老師排課時可選擇，並已留下異動紀錄。',true);},'courseMessage');};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  sb.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')showAuth();});
  (async()=>{try{const {data,error}=await sb.auth.getSession();if(error)throw error;if(data.session)await loadDashboard();}catch(error){message('authMessage',friendly(error));}})();
})();
