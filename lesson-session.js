/* Session gate runs before camera, microphone, room signaling or control. */
window.LessonSession = (() => {
  let closed=false, timer=null, deadline=0, lastVerified=0, panel=null;
  const label=document.createElement('p');
  const finish=document.createElement('button');
  async function checked(sb,id){
    let timeout;
    try{return await Promise.race([sb.rpc('gc_join',{p_lesson:id}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('連線逾時')),5000);})]);}
    finally{clearTimeout(timeout);}
  }
  function ui(){if(panel)return;panel=document.createElement('section');panel.style.cssText='position:fixed;inset:0;background:#f6f7f3;z-index:9999;display:grid;place-content:center;padding:30px;text-align:center;font:18px system-ui;color:#204d3b';const title=document.createElement('h2');title.textContent='等待進入教室';const back=document.createElement('a');back.href='./index.html';back.textContent='返回課表';panel.append(title,label,back);document.body.append(panel);}
  async function wait(sb,id){ui();label.textContent='正在確認課程時段…';
    while(!closed){
      const {data,error}=await checked(sb,id);
      if(error){label.textContent='尚未開放報到、課堂已結束或無法進入，請返回課表。';throw error;}
      if(data.state==='ready'){panel.remove();panel=null;return data;}
      label.textContent='前一堂正在收尾或教室正在交接，準備完成後會自動進入。候課期間不開啟影音或遠端控制。';
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  function monitor(sb,context,leave){
    const id=context.lesson.id;
    deadline=performance.now()+Math.max(0,new Date(context.lesson.ends_at).getTime()+300000-new Date(context.server_now).getTime());
    lastVerified=performance.now();let busy=false;
    finish.textContent=context.profile.role==='teacher'?'結束本堂課':'離開教室';finish.className='lesson-finish';
    document.querySelector('.toolbar').append(finish);
    const stop=()=>{if(closed)return;closed=true;clearInterval(timer);finish.remove();leave();};
    finish.onclick=async()=>{finish.disabled=true;const {error}=await sb.rpc(context.profile.role==='teacher'?'gc_end_lesson':'gc_leave_lesson',{p_lesson:id});if(error){finish.disabled=false;alert('尚未到下課時間，或連線失敗，請重試。');}else stop();};
    timer=setInterval(async()=>{
      const remaining=deadline-performance.now();finish.disabled=context.profile.role==='teacher'&&remaining>300000;
      if(remaining<=0||performance.now()-lastVerified>6500){stop();return;}
      if(busy)return;busy=true;
      try{const {data,error}=await checked(sb,id);if(error||data.state!=='ready'){stop();return;}lastVerified=performance.now();}
      catch{stop();}finally{busy=false;}
    },500);
    finish.disabled=context.profile.role==='teacher'&&deadline-performance.now()>300000;
    window.addEventListener('pagehide',()=>{closed=true;clearInterval(timer);},{once:true});
  }
  return {wait,monitor};
})();
