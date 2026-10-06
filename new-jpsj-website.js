/* =====================================================================
 * 建平世纪中学非官方站 · Cloudflare Worker 主文件
 * 模块: 学校简介 / 倒计时 / 临时云盘 / 上传风控
 * Bindings 需要: DB(D1) FILES_KV(KV) AI(Workers AI)
 * ===================================================================== */

/* ========================= 工具函数 ========================= */
const E = s => (s ?? '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json;charset=utf-8' } });
const H = h => new Response(h, { headers: { 'content-type': 'text/html;charset=utf-8' } });

/* ========================= Apple Design: 共享 CSS ========================= */
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
:root{
 --bg:#f2f2f5;--fg:#15151a;--dim:#6c6c76;--line:rgba(0,0,0,.08);
 --glass:rgba(255,255,255,.55);--glass2:rgba(255,255,255,.34);--edge:rgba(255,255,255,.75);
 --sh:0 1px 1px rgba(0,0,0,.04),0 6px 16px rgba(0,0,0,.06),0 24px 60px rgba(0,0,0,.07);
 --shH:0 1px 1px rgba(0,0,0,.05),0 12px 26px rgba(0,0,0,.09),0 36px 90px rgba(0,0,0,.11);
 --a:#667eea;--b:#764ba2;--c:#3b82f6;--d:#ec4899;
 font:100%/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
}
html[data-theme="dark"]{
 --bg:#08080b;--fg:#f2f2f7;--dim:#9a9aa4;--line:rgba(255,255,255,.1);
 --glass:rgba(32,32,38,.5);--glass2:rgba(28,28,34,.34);--edge:rgba(255,255,255,.14);
 --sh:0 1px 1px rgba(0,0,0,.5),0 8px 22px rgba(0,0,0,.45),0 28px 70px rgba(0,0,0,.5);
 --shH:0 1px 1px rgba(0,0,0,.55),0 14px 34px rgba(0,0,0,.55),0 44px 110px rgba(0,0,0,.6);
 --a:#3d5ea8;--b:#5d2f56;--c:#1e4a7a;--d:#7a2d5a;
}
body{background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;overflow-x:hidden;
 transition:background-color 0.6s linear,color 0.6s linear}

/* 流动柔和背景 */
.bgfx{position:fixed;inset:-20vmax;z-index:-3;filter:blur(80px) saturate(140%);opacity:.85;pointer-events:none}
html[data-theme="dark"] .bgfx{opacity:.6;filter:blur(96px) saturate(120%)}
.blob{position:absolute;border-radius:50%;mix-blend-mode:normal;opacity:.55;will-change:transform}
.b1{width:52vmax;height:52vmax;background:radial-gradient(circle at 30% 30%,var(--a),transparent 68%);top:-8%;left:-6%;animation:d1 46s ease-in-out infinite alternate}
.b2{width:46vmax;height:46vmax;background:radial-gradient(circle at 60% 40%,var(--b),transparent 68%);top:22%;right:-10%;animation:d2 58s ease-in-out infinite alternate}
.b3{width:50vmax;height:50vmax;background:radial-gradient(circle at 40% 60%,var(--c),transparent 68%);bottom:-14%;left:14%;animation:d3 52s ease-in-out infinite alternate}
.b4{width:34vmax;height:34vmax;background:radial-gradient(circle at 50% 50%,var(--d),transparent 68%);top:56%;left:52%;animation:d4 64s ease-in-out infinite alternate}
@keyframes d1{to{transform:translate3d(12vmax,8vmax,0) scale(1.15)}}
@keyframes d2{to{transform:translate3d(-14vmax,10vmax,0) scale(1.1)}}
@keyframes d3{to{transform:translate3d(10vmax,-12vmax,0) scale(1.18)}}
@keyframes d4{to{transform:translate3d(-9vmax,-7vmax,0) scale(.9)}}
.grain{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.035;
 background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence baseFrequency='.85' numOctaves='3'/></filter><rect width='140' height='140' filter='url(%23n)'/></svg>")}

/* 粒子画布 */
#particles{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5}
html[data-theme="dark"] #particles{opacity:.35}

.wrap{max-width:56rem;margin:0 auto;padding:7rem 1.5rem 5rem}
a{color:inherit;text-decoration:none}

/* 玻璃质感工具 */
.glass{background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%)}

/* 头部导航条 */
header{position:fixed;inset:.7rem .8rem auto .8rem;z-index:20;display:flex;align-items:center;gap:.6rem;
 justify-content:space-between;padding:.5rem .55rem .5rem .95rem;border-radius:999px;
 background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);overflow:hidden}
header b{font-weight:600;letter-spacing:-.01em;font-size:.95rem;white-space:nowrap}
.hud{display:flex;align-items:center;gap:.5rem;font-size:.78rem;color:var(--dim);font-variant-numeric:tabular-nums}
.hdr-title{font-weight:600;letter-spacing:-.01em;font-size:.95rem;white-space:nowrap;transition:opacity .3s linear}
.hdr-title:hover{opacity:.6}
#bar{position:absolute;left:0;bottom:0;height:2px;width:0;background:linear-gradient(90deg,transparent,var(--fg));opacity:.35}

/* 昼夜控件 */
.orb{width:1.15rem;height:1.15rem;border-radius:50%;position:relative;overflow:hidden;flex:none;
 background:radial-gradient(circle at 35% 32%,#ffd88a,#ff9d4d);box-shadow:0 0 12px rgba(255,170,80,.55);
 transition:background 0.6s linear,box-shadow 0.6s linear}
html[data-theme="dark"] .orb{background:radial-gradient(circle at 62% 38%,#e9edf7,#a9b3c9);box-shadow:0 0 12px rgba(190,205,255,.4)}
.orb::after{content:"";position:absolute;inset:0;border-radius:50%;background:var(--bg);
 transform:translate(120%,-40%);transition:transform 0.6s linear}
html[data-theme="dark"] .orb::after{transform:translate(38%,-26%)}

.seg{display:flex;position:relative;padding:.18rem;border-radius:999px;background:var(--glass2);border:1px solid var(--line)}
.seg button{position:relative;z-index:1;font:inherit;font-size:.74rem;font-weight:550;color:var(--dim);
 background:none;border:0;cursor:pointer;padding:.26rem .6rem;border-radius:999px;transition:color .3s linear}
.seg button[aria-pressed="true"]{color:var(--fg)}
#pill{position:absolute;top:.18rem;left:0;height:calc(100% - .36rem);border-radius:999px;background:var(--glass);
 box-shadow:var(--sh),inset 0 1px 0 var(--edge);will-change:transform,width}

/* 移动端：汉堡按钮 + 侧栏抽屉 */
.nav-btn{display:none;width:2.1rem;height:2.1rem;border-radius:50%;border:1px solid var(--line);background:var(--glass2);
 align-items:center;justify-content:center;flex:none;color:var(--fg);cursor:pointer}
.nav-btn svg{width:1.15rem;height:1.15rem;display:block}
.dscrim{position:fixed;inset:0;z-index:24;background:rgba(0,0,0,.32);backdrop-filter:blur(2px);
 opacity:0;pointer-events:none;transition:opacity .45s linear}
.dscrim.on{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;z-index:25;width:min(84vw,320px);transform:translateX(101%);
 background:var(--glass);border-left:1px solid var(--line);box-shadow:var(--shH),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);
 will-change:transform;touch-action:none;overflow-y:auto;padding:1rem 1.2rem 1.4rem;
 display:flex;flex-direction:column;gap:.9rem}
.drawer-head{display:flex;align-items:center;gap:.55rem;padding-bottom:.6rem;border-bottom:1px solid var(--line)}
.drawer-head img{width:1.6rem;height:1.6rem;border-radius:50%;object-fit:cover;flex:none}
.drawer-head b{font-size:.95rem;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drawer-close{width:1.9rem;height:1.9rem;border-radius:50%;border:1px solid var(--line);background:var(--glass2);
 color:var(--fg);font-size:.9rem;cursor:pointer;flex:none;line-height:1}
.drawer-user{display:flex;align-items:center;gap:.7rem;padding:.2rem .1rem}
.drawer-user img{width:2.6rem;height:2.6rem;border-radius:50%;object-fit:cover;border:1px solid var(--line);flex:none}
.drawer-user-meta{display:flex;flex-direction:column;gap:.35rem;min-width:0;font-size:.82rem;color:var(--dim)}
.drawer-user-meta .u-mail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);font-weight:550;font-size:.85rem}
.drawer-user-meta .u-acts{display:flex;gap:.4rem;flex-wrap:wrap}
.drawer-nav{display:flex;flex-direction:column;gap:.15rem}
.drawer-nav a{display:flex;align-items:center;gap:.6rem;padding:.65rem .8rem;border-radius:.8rem;
 font-size:.92rem;font-weight:550;color:var(--fg);transition:background .2s linear}
.drawer-nav a:active{background:var(--glass2)}
.drawer-nav .ico{font-size:1.05rem;width:1.3rem;text-align:center;flex:none}
.drawer-foot{margin-top:auto;padding-top:.6rem;border-top:1px solid var(--line)}
.drawer-foot .seg{margin-top:.5rem}
body.locked{overflow:hidden}
@media(max-width:860px){
 .nav-btn{display:flex}
 .hud{display:none}
 .hdr-title{overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
}

/* 排版 */
h1{font-size:clamp(2.1rem,6.2vw,3.5rem);line-height:1.04;letter-spacing:-.028em;font-weight:640;margin-bottom:.25em}
.lede{color:var(--dim);margin-top:1.1rem;font-size:1.05rem;max-width:34rem;margin-left:auto;margin-right:auto}

/* 卡片网格 */
.grid{margin-top:1.4rem;display:grid;gap:.85rem}
.card{position:relative;display:block;padding:1.25rem 1.35rem;border-radius:1.25rem;overflow:hidden;
 background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
 will-change:transform;transition:box-shadow .45s linear}
.card:hover{box-shadow:var(--shH),inset 0 1px 0 var(--edge)}
/* 相邻大控件统一留间隔 */
.wrap > .card + .card{margin-top:1rem}
.wrap > div + .card{margin-top:1.2rem}
.wrap > .card + div{margin-top:1.2rem}
.card .glare{position:absolute;inset:0;opacity:0;pointer-events:none;transition:opacity .5s linear;
 background:radial-gradient(18rem 18rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.35),transparent 60%)}
html[data-theme="dark"] .card .glare{background:radial-gradient(18rem 18rem at var(--mx,50%) var(--my,50%),rgba(255,255,255,.09),transparent 60%)}
.card:hover .glare{opacity:1}
.card h3{font-size:1.06rem;font-weight:600;letter-spacing:-.012em}
.card p{color:var(--dim);font-size:.92rem;margin-top:.22rem}
.card .arrow{position:absolute;right:1.2rem;top:1.25rem;color:var(--dim);opacity:0;transform:translateX(-.4rem);
 transition:opacity .45s linear,transform .45s linear}
.card:hover .arrow{opacity:1;transform:translateX(0)}

/* 入场揭示 */
.reveal{opacity:0;transform:translateY(14px)}
.reveal.in{opacity:1;transform:none;transition:opacity .7s linear,transform .7s cubic-bezier(.22,.61,.36,1)}

/* 交互反馈 */
.press{transition:transform 260ms linear,box-shadow 260ms linear}
.press:active{transform:scale(.965)}
.btn{font:inherit;font-size:.85rem;font-weight:550;padding:.45rem .95rem;border-radius:999px;cursor:pointer;
 color:var(--fg);background:var(--glass);border:1px solid var(--line);
 box-shadow:var(--sh),inset 0 1px 0 var(--edge);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);will-change:transform}
.btn.p{background:#0071e3;border-color:transparent;color:#fff;box-shadow:0 8px 24px rgba(0,113,227,.35)}

/* 打字机效果 */
#text{font-size:clamp(2.2rem,6.8vw,4rem);font-weight:640;line-height:1.08;letter-spacing:-.028em;color:var(--fg);margin-bottom:.6rem;display:inline-block}
.cursor{display:inline-block;width:3px;height:1em;background:var(--fg);margin-left:.1rem;animation:blink 1s step-end infinite;vertical-align:text-bottom}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

/* 副标题 */
.lede .highlight{background:var(--glass);padding:.15rem .5rem;border-radius:.35rem;border:1px solid var(--line);font-size:.88rem}

/* Toast通知 */
.toasts{position:fixed;top:1rem;right:1rem;z-index:50;display:flex;flex-direction:column;gap:.45rem;pointer-events:none}
.toast{padding:.6rem 1rem;border-radius:999px;font-size:.82rem;font-weight:550;pointer-events:auto;
 background:var(--glass);border:1px solid var(--line);box-shadow:var(--sh),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
 transform:translateX(120%);opacity:0;transition:transform .4s cubic-bezier(.22,.61,.36,1),opacity .4s linear}
.toast.in{transform:translateX(0);opacity:1}
.toast.ok{border-color:#34c759}
.toast.err{border-color:#ff3b30}

/* 子页通用 */
section{margin-top:2.6rem}
section h2{font-size:.76rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--dim)}
section .body{margin-top:.6rem;white-space:pre-wrap;font-size:1rem}
.back{font-size:.9rem;color:var(--dim)}

/* 输入框 */
.srch{width:100%;max-width:22rem;margin-top:1.2rem;font:inherit;font-size:.95rem;padding:.62rem .78rem;border-radius:.75rem;border:1px solid var(--line);
 background:var(--glass2);color:var(--fg);outline:none;transition:border-color .3s linear,background-color .3s linear}
.srch:focus{border-color:#0071e3}
label{display:block;font-size:.78rem;color:var(--dim);margin:.9rem 0 .3rem}
input,textarea{width:100%;font:inherit;font-size:.95rem;padding:.62rem .78rem;border-radius:.75rem;border:1px solid var(--line);
 background:var(--glass2);color:var(--fg);outline:none;transition:border-color .3s linear,background-color .3s linear}
input:focus,textarea:focus{border-color:#0071e3}
textarea{min-height:5.5rem;resize:vertical}
.row{display:flex;gap:.6rem;margin-top:1.2rem;justify-content:flex-end}

/* 模态与浮层 */
.scrim{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.32);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .45s linear}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:50%;bottom:0;z-index:31;width:min(38rem,100%);transform:translate(-50%,101%);
 max-height:88vh;overflow:auto;padding:.6rem 1.4rem 2rem;border-radius:1.6rem 1.6rem 0 0;
 background:var(--glass);border:1px solid var(--line);box-shadow:var(--shH),inset 0 1px 0 var(--edge);
 backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);will-change:transform;touch-action:none}
.grab{width:2.4rem;height:.3rem;border-radius:999px;background:var(--dim);opacity:.4;margin:.5rem auto 1rem}

/* 倒计时卡片 */
.flip-unit{display:flex;flex-direction:column;align-items:center;gap:8px}
.flip-label{font-size:11px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.flip-card-container{display:flex;gap:3px}
.flip-card{position:relative;width:48px;height:64px;perspective:200px}
.flip-card-top,.flip-card-top-flip{position:absolute;width:100%;height:50%;top:0;left:0;background:var(--glass);border-radius:4px 4px 0 0;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.14)}
.flip-card-top::after,.flip-card-top-flip::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:rgba(0,0,0,.2)}
.flip-card-bottom,.flip-card-bottom-flip{position:absolute;width:100%;height:50%;bottom:0;left:0;background:var(--glass);border-radius:0 0 4px 4px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.14)}
.flip-card-top-flip{transform-origin:bottom;transform:rotateX(0);z-index:2}
.flip-card-bottom-flip{transform-origin:top;transform:rotateX(0);z-index:1}
.flip-card.flipping .flip-card-top-flip{animation:flipTop .6s cubic-bezier(.4,0,.2,1) forwards}
.flip-card.flipping .flip-card-bottom-flip{animation:flipBottom .6s cubic-bezier(.4,0,.2,1) forwards}
@keyframes flipTop{0%{transform:rotateX(0)}100%{transform:rotateX(-90deg)}}
@keyframes flipBottom{0%{transform:rotateX(90deg)}100%{transform:rotateX(0)}}
.flip-number{position:absolute;width:100%;height:200%;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:600;color:var(--fg)}
.flip-card-top .flip-number,.flip-card-top-flip .flip-number{top:0}
.flip-card-bottom .flip-number,.flip-card-bottom-flip .flip-number{bottom:0}

/* 云盘拖拽区 */
.drop-zone{border:2px dashed var(--line);border-radius:1rem;padding:40px 20px;text-align:center;transition:.2s;cursor:pointer;background:var(--glass2)}
.drop-zone.drag{border-color:#0071e3;background:var(--glass)}

/* 物理测验 */
.progress-track{height:6px;background:var(--glass2);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:#0071e3;transition:width .2s}
.score-circle{width:140px;height:140px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;margin:0 auto 20px;color:#fff;font-weight:600}
.score-circle.pass{background:linear-gradient(135deg,#107c10,#0b5a08)}
.score-circle.fail{background:linear-gradient(135deg,#a80000,#6e0000)}
.score-num{font-size:42px;line-height:1}
.score-label{font-size:12px;margin-top:4px;letter-spacing:2px}

/* 空状态 */
.empty{color:var(--dim);padding:3rem 0;text-align:center}

/* 词典释义推荐下拉 */
.sug-wrap{position:relative}
.sug-box{position:absolute;top:100%;left:0;right:0;z-index:10;margin-top:.3rem;display:none;overflow:hidden;
 background:var(--glass);border:1px solid var(--line);border-radius:.75rem;box-shadow:var(--shH);
 backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}
.sug-item{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.5rem .8rem;cursor:pointer;font-size:.85rem}
.sug-item:hover{background:var(--glass2)}
.sug-item b{font-weight:600;white-space:nowrap}
.sug-item span{color:var(--dim);font-size:.8rem;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

@media(prefers-reduced-motion:reduce){
 .blob{animation:none}.reveal{opacity:1;transform:none}.cursor{animation:none;opacity:1}
 .press:active{transform:none;opacity:.7}#particles{display:none}
}
@media(prefers-reduced-transparency:reduce){
 header,.card,.sheet,.btn,.stat,.chip{backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--bg)}
 .bgfx{display:none}
}
@media(prefers-contrast:more){.card,.btn,.stat{border-color:var(--fg)}}
`;

/* ========================= Apple Design: 共享客户端脚本 ========================= */
const BASE_JS = `
const RM=matchMedia('(prefers-reduced-motion: reduce)');
function spring(from,to,v,cb,{bounce=0,duration=.4}={}){
 if(RM.matches){cb(to);return()=>{}}
 let x=from,vel=v,z=1-bounce,w=6.2831853/duration,raf,last=performance.now();
 const tick=t=>{const dt=Math.min((t-last)/1000,.032);last=t;
  vel+=(-w*w*(x-to)-2*z*w*vel)*dt;x+=vel*dt;cb(x);
  if(Math.abs(x-to)<.4&&Math.abs(vel)<8){cb(to);return}raf=requestAnimationFrame(tick)};
 raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);
}
const project=(v,d=.998)=>(v/1000)*d/(1-d);

/* 昼夜：自动（按本地时间），可手动覆盖 */
const R=document.documentElement;
function autoTheme(){const h=new Date().getHours();
 const sys=matchMedia('(prefers-color-scheme: dark)').matches;
 return (h<6||h>=19)?'dark':(sys?'dark':'light');}
function applyTheme(){const m=localStorage.theme||'auto';
 R.dataset.theme=m==='auto'?autoTheme():m;
 document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.t===m));
 movePill();}
function movePill(){document.querySelectorAll('.seg').forEach(s=>{const p=s.querySelector('#pill');if(!p)return;
 const a=s.querySelector('.seg button[aria-pressed="true"]');if(!a)return;
 p.style.width=a.offsetWidth+'px';p.style.transform='translateX('+a.offsetLeft+'px)';})}
applyTheme();setInterval(applyTheme,60000);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);

/* 点击反馈：pointerdown 即响应 */
addEventListener('pointerdown',e=>{const t=e.target.closest('.press');if(t)t.classList.add('down')},true);
['pointerup','pointercancel'].forEach(k=>addEventListener(k,()=>document.querySelectorAll('.down').forEach(t=>t.classList.remove('down')),true));

/* 滚动进度条 */
const bar=document.getElementById('bar');
if(bar)addEventListener('scroll',()=>{const h=document.body.scrollHeight-innerHeight;
 bar.style.width=(h>0?scrollY/h*100:0)+'%'},{passive:true});

/* 时钟 */
const clock=document.getElementById('clock');
if(clock){const tick=()=>{const d=new Date();
 clock.textContent=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');};tick();setInterval(tick,10000);}

/* 入场揭示 */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.12});
document.querySelectorAll('.reveal').forEach((el,i)=>{el.style.transitionDelay=Math.min(i*60,360)+'ms';io.observe(el)});

/* 卡片光泽跟随 */
document.querySelectorAll('.card').forEach(c=>c.addEventListener('pointermove',e=>{
 const r=c.getBoundingClientRect();
 c.style.setProperty('--mx',(e.clientX-r.left)+'px');c.style.setProperty('--my',(e.clientY-r.top)+'px');},{passive:true}));

/* 数字滚动 */
document.querySelectorAll('[data-count]').forEach(el=>{
 const n=+el.dataset.count;if(RM.matches){el.textContent=n;return}
 let s=null;const step=t=>{s??=t;const p=Math.min((t-s)/900,1);
  el.textContent=Math.round(n*(1-Math.pow(1-p,3)));if(p<1)requestAnimationFrame(step)};requestAnimationFrame(step);});

/* toast 通知 */
function toast(msg,type=''){const c=document.querySelector('.toasts')||(()=>{const d=document.createElement('div');d.className='toasts';document.body.appendChild(d);return d})();
 const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;c.appendChild(t);
 requestAnimationFrame(()=>{t.classList.add('in')});
 setTimeout(()=>{t.classList.remove('in');setTimeout(()=>t.remove(),400)},2200);}
const tm=sessionStorage.getItem('toast'),tt=sessionStorage.getItem('toastType');
if(tm){sessionStorage.removeItem('toast');sessionStorage.removeItem('toastType');setTimeout(()=>toast(tm,tt||''),400);}
`;

/* ========================= 主题切换 JS ========================= */
const SEG_JS = `
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{localStorage.theme=b.dataset.t;applyTheme()});
addEventListener('resize',movePill);requestAnimationFrame(movePill);
`;

/* ========================= Sheet 交互 JS ========================= */
const SHEET_JS = `
function makeSheet(el,scrim){
 let y=el.offsetHeight,stop=()=>{},open=false;
 const set=v=>{y=v;el.style.transform='translate(-50%,'+v+'px)'};
 const h=()=>el.offsetHeight;set(h());
 const show=()=>{open=true;scrim.classList.add('on');stop();stop=spring(y,0,0,set,{bounce:.2,duration:.35})};
 const hide=()=>{open=false;scrim.classList.remove('on');stop();stop=spring(y,h(),0,set,{bounce:0,duration:.3})};
 let hist=[],grab=0,drag=false;
 el.addEventListener('pointerdown',e=>{if(['INPUT','TEXTAREA','BUTTON'].includes(e.target.tagName))return;
  el.setPointerCapture(e.pointerId);stop();drag=true;grab=e.clientY-y;hist=[[e.clientY,performance.now()]]});
 el.addEventListener('pointermove',e=>{if(!drag)return;let n=e.clientY-grab;if(n<0)n=-rubber(-n,h());set(n);
  hist.push([e.clientY,performance.now()]);if(hist.length>5)hist.shift()});
 const up=()=>{if(!drag)return;drag=false;
  const a=hist[0],b=hist[hist.length-1],dt=Math.max(b[1]-a[1],1),v=(b[0]-a[0])/dt*1000;
  const end=y+project(v);stop();
  if(end>h()*.4){open=false;scrim.classList.remove('on');stop=spring(y,h(),v,set,{bounce:0,duration:.3})}
  else stop=spring(y,0,v,set,{bounce:.2,duration:.35})};
 el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);
 scrim.addEventListener('click',hide);addEventListener('resize',()=>{if(!open)set(h())});
 return{show,hide};
}
const rubber=(o,dim,c=.55)=>(o*dim*c)/(dim+c*Math.abs(o));
`;

/* ========================= 移动端侧栏抽屉 JS ========================= */
const DRAWER_JS = `
function initDrawer(){
  const d=document.getElementById('drawer'),sc=document.getElementById('dscrim');
  if(!d||!sc)return;
  let x=0,stop=()=>{},open=false;
  const W=()=>Math.min(innerWidth*.84,320);
  const set=v=>{x=v;d.style.transform='translateX('+v+'px)'};
  set(W());
  const show=()=>{if(open)return;open=true;sc.classList.add('on');document.body.classList.add('locked');
   stop();stop=spring(x,0,0,set,{bounce:.2,duration:.38});if(typeof movePill==='function')movePill()};
  const hide=()=>{if(!open)return;open=false;sc.classList.remove('on');document.body.classList.remove('locked');
   stop();stop=spring(x,W(),0,set,{bounce:0,duration:.3})};
  const btn=document.getElementById('navBtn');
  if(btn)btn.addEventListener('click',show);
  const cls=document.getElementById('drawerClose');
  if(cls)cls.addEventListener('click',hide);
  sc.addEventListener('click',hide);
  addEventListener('resize',()=>{if(!open)set(W())});
  addEventListener('keydown',e=>{if(e.key==='Escape'&&open)hide()});
  window._drawer={show,hide};
}
initDrawer();
`;

/* ========================= 登录状态 JS（共享头部，token 存 cookie 持久化） ========================= */
const AUTH_JS = `
function getToken(){try{const m=document.cookie.match(/(?:^|; )jpsj_token=([^;]*)/);if(m)return decodeURIComponent(m[1])}catch(e){}return localStorage.getItem('jpsj_token')||''}
function setToken(t){try{document.cookie='jpsj_token='+encodeURIComponent(t)+';max-age=604800;path=/;SameSite=Lax'}catch(e){}try{localStorage.setItem('jpsj_token',t)}catch(e){}}
function clearToken(){try{document.cookie='jpsj_token=;max-age=0;path=/;SameSite=Lax'}catch(e){}try{localStorage.removeItem('jpsj_token')}catch(e){}}
window.logout=async function(){try{await fetch('/api/auth/logout',{method:'POST'})}catch(e){}clearToken();location.href='/'};
const AVATAR_PLACEHOLDER='data:image/svg+xml;utf8,'+encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23aeb3bf'><circle cx='12' cy='8' r='4'/><path d='M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z'/></svg>");
(async function(){
  const loginEl=document.getElementById('authLogin'),driveEl=document.getElementById('authDrive'),
        mailEl=document.getElementById('authEmail'),outEl=document.getElementById('logoutBtn'),
        avEl=document.getElementById('authAvatar'),avIn=document.getElementById('authAvatarInput');
  if(!loginEl)return;
  try{
    const r=await fetch('/api/auth/me',{headers:getToken()?{'Authorization':'Bearer '+getToken()}:{}});
    const d=await r.json();
    if(d.authenticated){
      loginEl.style.display='none';
      if(driveEl)driveEl.style.display='';
      const accEl=document.getElementById('authAccount'),admEl=document.getElementById('authAdmin');
      if(accEl)accEl.style.display='';
      if(admEl)admEl.style.display=(d.user&&d.user.role==='admin')?'':'none';
      if(mailEl){mailEl.style.display='';mailEl.textContent=d.user.email}
      if(outEl)outEl.style.display='';
      if(avEl){avEl.src=(d.user&&d.user.avatar)||AVATAR_PLACEHOLDER;avEl.style.display=''}
      window._myId=d.user?d.user.id:null;
      /* 抽屉版用户区同步 */
      const mL=document.getElementById('mLogin'),mR=document.getElementById('mRegister'),
            mD=document.getElementById('mDrive'),mC=document.getElementById('mAccount'),
            mA=document.getElementById('mAdmin'),mE=document.getElementById('mEmail'),
            mO=document.getElementById('mLogout'),mAv=document.getElementById('mAvatar');
      if(mL)mL.style.display='none';if(mR)mR.style.display='none';
      if(mD)mD.style.display='';if(mC)mC.style.display='';
      if(mA)mA.style.display=(d.user&&d.user.role==='admin')?'':'none';
      if(mE){mE.style.display='';mE.textContent=d.user.email}
      if(mO)mO.style.display='';
      if(mAv){mAv.src=(d.user&&d.user.avatar)||AVATAR_PLACEHOLDER;mAv.style.display=''}
    }
  }catch(e){}
  const mAv=document.getElementById('mAvatar'),mIn=document.getElementById('mAvatarInput');
  if(avEl)avEl.onclick=function(){if(avIn)avIn.click()};
  if(avIn)avIn.addEventListener('change',function(){uploadAvatar(this.files[0]);this.value=''});
  if(mAv)mAv.onclick=function(){if(mIn)mIn.click()};
  if(mIn)mIn.addEventListener('change',function(){uploadAvatar(this.files[0]);this.value=''});
})();
async function uploadAvatar(f){
  if(!f)return;
  const fd=new FormData();fd.append('file',f);
  try{
    const r=await fetch('/api/avatar',{method:'POST',headers:getToken()?{'Authorization':'Bearer '+getToken()}:{},body:fd});
    const d=await r.json();
    if(d.success){document.querySelectorAll('#authAvatar,#mAvatar').forEach(i=>{i.src=d.avatar;i.style.display=''})}
    else alert(d.error||'头像上传失败');
  }catch(e){alert('头像上传失败')}
}
`;

/* ========================= 共享页面 Chrome（背景 + 头部） ========================= */
const CHROME = `
<div class="bgfx"><div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div><div class="blob b4"></div></div>
<div class="grain"></div>
<header>
  <a href="/" class="hdr-title"><img src="https://mirror.qlzx.lol/https://i.imgur.com/ARm1yD2.jpeg" alt="logo" style="width:1.35rem;height:1.35rem;border-radius:50%;object-fit:cover;vertical-align:text-bottom;margin-right:.3rem"><b>上海市建平世纪中学</b></a>
  <div class="hud"><span class="orb"></span><span id="clock">--:--</span>
    <div class="seg"><div id="pill"></div>
      <button data-t="auto">自动</button><button data-t="light">日</button><button data-t="dark">夜</button>
    </div>
    <span id="authBox" style="display:flex;align-items:center;gap:.4rem">
      <a id="authLogin" class="btn press" style="padding:.3rem .7rem;font-size:.75rem" href="/login">登录</a>
      <a id="authDrive" class="btn press" style="padding:.3rem .7rem;font-size:.75rem;display:none" href="/drive">我的云盘</a>
      <a id="authAccount" class="btn press" style="padding:.3rem .7rem;font-size:.75rem;display:none" href="/account">账号</a>
      <a id="authAdmin" class="btn press" style="padding:.3rem .7rem;font-size:.75rem;display:none;color:#c50f1e" href="/admin">管理</a>
      <img id="authAvatar" title="点击更换头像" alt="头像" style="width:1.7rem;height:1.7rem;border-radius:50%;object-fit:cover;display:none;cursor:pointer">
      <input type="file" id="authAvatarInput" accept="image/*" style="display:none">
      <span id="authEmail" style="font-size:.72rem;color:var(--dim);display:none;max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <button id="logoutBtn" class="btn press" style="padding:.3rem .7rem;font-size:.75rem;display:none" onclick="logout()">退出</button>
    </span>
  </div>
  <button id="navBtn" class="nav-btn press" aria-label="菜单">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
  </button>
  <div id="bar"></div>
</header>
<div id="dscrim" class="dscrim"></div>
<aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-label="导航菜单">
  <div class="drawer-head">
    <img src="https://mirror.qlzx.lol/https://i.imgur.com/ARm1yD2.jpeg" alt="logo">
    <b>上海市建平世纪中学</b>
    <button id="drawerClose" class="drawer-close press" aria-label="关闭">✕</button>
  </div>
  <div class="drawer-user">
    <img id="mAvatar" alt="头像">
    <input type="file" id="mAvatarInput" accept="image/*" style="display:none">
    <div class="drawer-user-meta">
      <span class="u-mail" id="mEmail"></span>
      <div class="u-acts">
        <a id="mLogin" class="btn press" style="padding:.25rem .7rem;font-size:.78rem" href="/login">登录</a>
        <a id="mRegister" class="btn press" style="padding:.25rem .7rem;font-size:.78rem" href="/register">注册</a>
        <a id="mDrive" class="btn press" style="padding:.25rem .7rem;font-size:.78rem;display:none" href="/drive">我的云盘</a>
        <a id="mAccount" class="btn press" style="padding:.25rem .7rem;font-size:.78rem;display:none" href="/account">账号</a>
        <a id="mAdmin" class="btn press" style="padding:.25rem .7rem;font-size:.78rem;display:none;color:#c50f1e" href="/admin">管理</a>
        <button id="mLogout" class="btn press" style="padding:.25rem .7rem;font-size:.78rem;display:none" onclick="logout()">退出</button>
      </div>
    </div>
  </div>
  <nav class="drawer-nav">
    <a href="/"><span class="ico">🏠</span>首页</a>
    <a href="/about"><span class="ico">📋</span>学校简介</a>
    <a href="/countdown"><span class="ico">⏰</span>倒计时</a>
    <a href="/words"><span class="ico">📖</span>英语单词本</a>
    <a href="/drive"><span class="ico">📁</span>我的云盘</a>
  </nav>
  <div class="drawer-foot">
    <span style="font-size:.72rem;color:var(--dim)">外观</span>
    <div class="seg"><div id="pill"></div>
      <button data-t="auto">自动</button><button data-t="light">日</button><button data-t="dark">夜</button>
    </div>
  </div>
</aside>`;

/* ========================= 页面模板包装器 ========================= */
function page(title, body, extra = '', status = 200) {
  return new Response(`<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${E(title)}</title><style>${CSS}</style>
<script>(function(){var m=localStorage.theme||'auto',h=new Date().getHours();
document.documentElement.dataset.theme=m==='auto'?((h<6||h>=19)?'dark':(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')):m})()</script>
</head><body>${CHROME}${body}
<script>${BASE_JS}${SEG_JS}${SHEET_JS}${DRAWER_JS}${AUTH_JS}${extra}</script></body></html>`, { status, headers: { 'content-type': 'text/html;charset=utf-8' } });
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};

/* ================= 自动建表（幂等） ================= */

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        avatar TEXT NOT NULL DEFAULT '',
        banned INTEGER NOT NULL DEFAULT 0,
        pending_email TEXT NOT NULL DEFAULT ''
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS email_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'register',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used INTEGER NOT NULL DEFAULT 0
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_codes_email ON email_codes(email, purpose)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        word TEXT NOT NULL,
        translation TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, word)
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_words_user ON words(user_id)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS drive_files (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        uploaded_at INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_drive_user ON drive_files(user_id)`)
    ]);
    /* 旧库补列（列已存在则忽略错误） */
    for (const ddl of [
      `ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN pending_email TEXT NOT NULL DEFAULT ''`,
      /* 云盘分片：0 = 老格式单键 file:<id>，>0 = file:<id>:<n> 共 n 片 */
      `ALTER TABLE drive_files ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0`
    ]) {
      try {
        await env.DB.prepare(ddl).run();
      } catch (e) { /* duplicate column 忽略 */ }
    }
    schemaReady = true;
  } catch (e) {
    console.error('自动建表失败:', e);
  }
}

/* ================= 主路由 ================= */

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  await ensureSchema(env);

  /* ---- 维护模式管理 ---- */
  if (url.pathname === '/api/maintenance/enable' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'true').run();
    return jsonResp({ success: true, message: '维护模式已开启' });
  }
  if (url.pathname === '/api/maintenance/disable' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('maintenance_mode', 'false').run();
    return jsonResp({ success: true, message: '维护模式已关闭' });
  }
  if (url.pathname === '/api/maintenance/status') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return jsonResp({ success: true, maintenanceMode: await checkMaintenanceMode(env) });
  }

  /* ---- 维护模式拦截（主页/404 除外）---- */
  if (url.pathname !== '/' && url.pathname !== '/404' && url.pathname !== '/404.html') {
    if (await checkMaintenanceMode(env)) {
      return get404HTML();
    }
  }

  /* ---- 认证 / 单词本 API ---- */
  if (url.pathname === '/api/auth/register' && request.method === 'POST') return handleRegister(request, env);
  if (url.pathname === '/api/auth/verify-email' && request.method === 'POST') return handleVerifyEmail(request, env);
  if (url.pathname === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return handleAuthLogout(request, env);
  if (url.pathname === '/api/auth/change-email' && request.method === 'POST') return handleChangeEmail(request, env);
  if (url.pathname === '/api/auth/me') return handleAuthMe(request, env);
  if (url.pathname === '/api/avatar' && request.method === 'POST') return handleAvatarUpload(request, env);
  if (url.pathname === '/api/dict/suggest') return handleDictSuggest(request, env);

  /* ---- 管理员 · 用户管理 ---- */
  if (url.pathname === '/api/admin/users') return handleAdminUsers(request, env);
  if (url.pathname === '/api/admin/users/ban' && request.method === 'POST') return handleAdminBan(request, env);
  if (url.pathname === '/api/admin/users/delete' && request.method === 'POST') return handleAdminDelete(request, env);
  if (url.pathname === '/api/admin/users/password' && request.method === 'POST') return handleAdminPassword(request, env);
  if (url.pathname === '/api/words/list') return handleWordsList(request, env);
  if (url.pathname === '/api/words/add' && request.method === 'POST') return handleWordsAdd(request, env);
  if (url.pathname === '/api/words/delete' && request.method === 'POST') return handleWordsDelete(request, env);

  /* ---- 倒计时 ---- */
  if (url.pathname === '/countdown.html' || url.pathname === '/countdown') {
    return getCountdownHTML();
  }
  if (url.pathname === '/api/countdowns') return handleCountdownsAPI(env);
  if (url.pathname === '/api/countdown/add' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAddCountdown(request, env);
  }
  if (url.pathname === '/api/countdown/delete' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleDeleteCountdown(request, env);
  }

  /* ---- 临时云盘 ---- */
  if (url.pathname === '/drive' || url.pathname === '/drive.html') {
    return getDriveHTML();
  }
  /* 分片上传：init 建会话 -> chunk × N -> complete 收尾；任何一步失败都该调 abort 清理 */
  if (url.pathname === '/api/drive/upload/init' && request.method === 'POST') {
    return handleDriveUploadInit(request, env);
  }
  if (url.pathname === '/api/drive/upload/chunk' && request.method === 'POST') {
    return handleDriveUploadChunk(request, env);
  }
  if (url.pathname === '/api/drive/upload/complete' && request.method === 'POST') {
    return handleDriveUploadComplete(request, env, ctx);
  }
  if (url.pathname === '/api/drive/upload/abort' && request.method === 'POST') {
    return handleDriveUploadAbort(request, env);
  }
  if (url.pathname === '/api/drive/usage') return handleDriveUsage(request, env);
  /* 老页面（缓存的 HTML）还在用的一次性上传，保留 */
  if (url.pathname === '/api/drive/upload' && request.method === 'POST') {
    return handleDriveUpload(request, env, ctx);
  }
  if (url.pathname === '/api/drive/list') return handleDriveList(request, env);
  if (url.pathname.startsWith('/api/drive/file/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/drive/file/', ''));
    return handleDriveDownload(id, env, request);
  }
  if (url.pathname === '/api/drive/delete' && request.method === 'POST') {
    return handleDriveDelete(request, env);
  }
  if (url.pathname === '/api/drive/rl/status') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleRlStatus(request, env);
  }
  if (url.pathname === '/api/drive/rl/unblock' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleRlUnblock(request, env);
  }
  if (url.pathname === '/api/rl/auth/reset' && request.method === 'POST') {
    if (!isAdmin(request, env)) return new Response('Unauthorized', { status: 401 });
    return handleAuthRlReset(request, env);
  }
  /* ---- 404 / 主页 ---- */
  if (url.pathname === '/404' || url.pathname === '/404.html') {
    return get404HTML();
  }
  if (url.pathname === '/about' || url.pathname === '/about.html') {
    return getAboutHTML();
  }
  if (url.pathname === '/login') return getLoginHTML();
  if (url.pathname === '/register') return getRegisterHTML();
  if (url.pathname === '/words' || url.pathname === '/words.html') return getWordsHTML();
  if (url.pathname === '/account') return getAccountHTML();
  if (url.pathname === '/admin') return getAdminHTML();
  if (url.pathname === '/') {
    return getMainHTML();
  }

  return get404HTML();
}

/* ================= 通用工具 ================= */

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', ...extraHeaders }
  });
}

function isAdmin(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}

/* ================= 密码安全 / JWT 会话 ================= */

const te = new TextEncoder();
const toHex = (b) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(str) {
  return toHex(await crypto.subtle.digest('SHA-256', te.encode(str)));
}

/* PBKDF2-HMAC-SHA256: 10万轮迭代, 每用户随机32字节盐 */
async function pbkdf2(password, saltHex, iterations = 100000) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return toHex(bits);
}

const randHex = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return toHex(a); };
const randCode = () => String(Math.floor(100000 + Math.random() * 900000));

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const b64uBytes = (buf) => {
  let bin = ''; const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uEncode = (obj) => b64uBytes(te.encode(JSON.stringify(obj)));
const b64uDecode = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(
  atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));

async function signJwt(payload, env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET 未配置');
  const data = b64uEncode({ alg: 'HS256', typ: 'JWT' }) + '.' + b64uEncode(payload);
  const key = await crypto.subtle.importKey('raw', te.encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(data));
  return data + '.' + b64uBytes(sig);
}

async function verifyJwt(token, env) {
  try {
    if (!env.JWT_SECRET) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const data = parts[0] + '.' + parts[1];
    const key = await crypto.subtle.importKey('raw', te.encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sig, te.encode(data));
    if (!ok) return null;
    const payload = b64uDecode(parts[1]);
    if (!payload.sub || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    const m = /(?:^|;\s*)jpsj_token=([^;]+)/.exec(request.headers.get('Cookie') || '');
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) return null;
  const payload = await verifyJwt(token, env);
  if (!payload) return null;
  try {
    const { results } = await env.DB.prepare('SELECT id, email, role, email_verified, avatar, banned FROM users WHERE id = ?').bind(payload.sub).all();
    if (!results || !results.length) return null;
    const u = results[0];
    if (u.banned) return null; // 封禁用户视为未登录，所有受保护接口一律拒绝
    return { id: u.id, email: u.email, role: u.role, email_verified: u.email_verified, avatar: u.avatar || '' };
  } catch (e) { return null; }
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown';

/* KV 速率限制: rl:auth:<key> 窗口内计数 */
async function rlHit(env, key, windowSec, max) {
  const k = 'rl:auth:' + key;
  const cur = parseInt(await env.FILES_KV.get(k) || '0', 10) || 0;
  const next = cur + 1;
  await env.FILES_KV.put(k, String(next), { expirationTtl: windowSec });
  return next > max;
}

/* ================= 邮箱验证码发送（GitHub Action 代理） ================= */

async function dispatchVerificationEmail(email, code, env) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: 'GITHUB_TOKEN 未配置' };
  try {
    const r = await fetch('https://api.github.com/repos/xingnengmao666/PythonProject/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'jianping-century-worker'
      },
      body: JSON.stringify({ event_type: 'send-verification-email', client_payload: { email, code } })
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ================= 认证路由 ================= */

async function handleRegister(request, env) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return jsonResp({ success: false, error: '邮箱和密码不能为空' }, 400);
    const em = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return jsonResp({ success: false, error: '邮箱格式不正确' }, 400);
    const pw = String(password);
    if (pw.length < 6 || pw.length > 72) return jsonResp({ success: false, error: '密码长度需在 6-72 位之间' }, 400);
    if (await rlHit(env, 'reg:' + clientIp(request), 3600, 5)) return jsonResp({ success: false, error: '注册过于频繁，请稍后再试' }, 429);

    const { results } = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(em).all();
    if (results.length && results[0].email_verified) return jsonResp({ success: false, error: '该邮箱已注册' }, 400);

    /* 首次注册建号(未验证)；已存在未验证则视为重发验证码，刷新密码 */
    const salt = randHex(32);
    const hash = await pbkdf2(pw, salt);
    if (!results.length) {
      await env.DB.prepare('INSERT INTO users (email, password_hash, role, created_at, email_verified) VALUES (?,?,?,?,0)')
        .bind(em, salt + ':' + hash, 'user', Date.now()).run();
    } else {
      await env.DB.prepare('UPDATE users SET password_hash=? WHERE email=?').bind(salt + ':' + hash, em).run();
    }

    const code = randCode();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO email_codes (email, code_hash, purpose, created_at, expires_at) VALUES (?,?,?,?,?)')
      .bind(em, await sha256Hex(code), 'register', now, now + 60 * 1000).run();

    const send = await dispatchVerificationEmail(em, code, env);
    if (!send.ok) console.error('[邮件] 发送失败:', send.error || send.status);
    return jsonResp({ success: true, message: '验证码已发送，60秒内有效', emailed: send.ok });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleVerifyEmail(request, env) {
  try {
    const { email, code, purpose } = await request.json();
    if (!email || !code) return jsonResp({ success: false, error: '缺少邮箱或验证码' }, 400);
    const em = String(email).trim().toLowerCase();
    const pur = purpose === 'change_email' ? 'change_email' : 'register';
    const codeStr = String(code).trim();
    if (!/^\d{6}$/.test(codeStr)) return jsonResp({ success: false, error: '验证码为 6 位数字' }, 400);
    const now = Date.now();

    const { results } = await env.DB.prepare(
      'SELECT id, code_hash, expires_at, attempts FROM email_codes WHERE email=? AND purpose=? AND used=0 ORDER BY created_at DESC LIMIT 1'
    ).bind(em, pur).all();
    if (!results.length) return jsonResp({ success: false, error: '未找到验证码，请重新发送' }, 400);
    const rec = results[0];
    if (rec.attempts >= 5) {
      await env.DB.prepare('UPDATE email_codes SET used=1 WHERE id=?').bind(rec.id).run();
      return jsonResp({ success: false, error: '尝试次数过多，请重新发送验证码' }, 400);
    }
    if (rec.expires_at < now) return jsonResp({ success: false, error: '验证码已过期，请重新发送' }, 400);

    if (!timingSafeEqual(await sha256Hex(codeStr), rec.code_hash)) {
      await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id=?').bind(rec.id).run();
      return jsonResp({ success: false, error: '验证码错误' }, 400);
    }
    await env.DB.prepare('UPDATE email_codes SET used=1 WHERE id=?').bind(rec.id).run();

    if (pur === 'change_email') {
      /* 改绑邮箱: 新邮箱已通过验证码确认，把 pending_email 变为正式邮箱 */
      const upd = await env.DB.prepare("UPDATE users SET email=?, pending_email='' WHERE pending_email=?").bind(em, em).run();
      if (!upd.meta || upd.meta.changes < 1) return jsonResp({ success: false, error: '未找到待改绑的账号，请重新发起' }, 400);
      return jsonResp({ success: true, message: '邮箱已更换，下次请用新邮箱登录' });
    }

    const role = (em === env.ADMIN_EMAIL) ? 'admin' : 'user';
    await env.DB.prepare('UPDATE users SET email_verified=1, role=? WHERE email=?').bind(role, em).run();
    return jsonResp({ success: true, message: '邮箱验证成功，可以登录了' });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

/* 改绑邮箱: 校验密码 → 发验证码到新邮箱 → 设置 pending_email，随后由 verify-email(change_email) 生效 */
async function handleChangeEmail(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const { email, password } = await request.json();
    if (!email || !password) return jsonResp({ success: false, error: '缺少新邮箱或密码' }, 400);
    const ne = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ne)) return jsonResp({ success: false, error: '邮箱格式不正确' }, 400);
    if (ne === user.email) return jsonResp({ success: false, error: '新邮箱与当前邮箱相同' }, 400);

    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(user.id).first();
    const [salt, storedHash] = String(row?.password_hash || '').split(':');
    if (!storedHash || !timingSafeEqual(await pbkdf2(String(password), salt), storedHash)) {
      return jsonResp({ success: false, error: '密码错误' }, 400);
    }
    const ex = await env.DB.prepare('SELECT id FROM users WHERE email=? AND id<>?').bind(ne, user.id).all();
    if (ex.results.length) return jsonResp({ success: false, error: '该邮箱已被注册' }, 400);
    if (await rlHit(env, 'chgemail:' + clientIp(request), 3600, 5)) return jsonResp({ success: false, error: '操作过于频繁，请稍后再试' }, 429);

    const code = randCode();
    const now = Date.now();
    await env.DB.prepare('INSERT INTO email_codes (email, code_hash, purpose, created_at, expires_at) VALUES (?,?,?,?,?)')
      .bind(ne, await sha256Hex(code), 'change_email', now, now + 60 * 1000).run();
    await env.DB.prepare('UPDATE users SET pending_email=? WHERE id=?').bind(ne, user.id).run();

    const send = await dispatchVerificationEmail(ne, code, env);
    if (!send.ok) console.error('[邮件] 改绑邮箱发送失败:', send.error || send.status);
    return jsonResp({ success: true, message: '验证码已发送到新邮箱，60秒内有效', emailed: send.ok });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleLogin(request, env) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return jsonResp({ success: false, error: '请输入邮箱和密码' }, 400);
    const em = String(email).trim().toLowerCase();
    if (await rlHit(env, 'login:' + clientIp(request), 900, 5)) return jsonResp({ success: false, error: '尝试次数过多，请 15 分钟后再试' }, 429);

    const { results } = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(em).all();
    if (!results.length) return jsonResp({ success: false, error: '邮箱或密码错误' }, 401);
    const u = results[0];
    const [salt, storedHash] = String(u.password_hash).split(':');
    if (!storedHash || !timingSafeEqual(await pbkdf2(String(password), salt), storedHash)) {
      return jsonResp({ success: false, error: '邮箱或密码错误' }, 401);
    }
    if (u.banned) return jsonResp({ success: false, error: '该账号已被封禁，请联系管理员' }, 403);
    if (!u.email_verified) return jsonResp({ success: false, error: '请先验证邮箱后再登录' }, 403);

    const token = await signJwt({ sub: u.id, email: u.email, role: u.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 }, env);
    return jsonResp({ success: true, token, user: { id: u.id, email: u.email, role: u.role, avatar: u.avatar || '' } }, 200,
      { 'Set-Cookie': 'jpsj_token=' + encodeURIComponent(token) + '; Max-Age=604800; Path=/; SameSite=Lax' });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleAuthMe(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, authenticated: false }, 401);
  return jsonResp({ success: true, authenticated: true, user });
}

/* 退出登录: 清掉会话 cookie（HttpOnly/普通 cookie 均可由服务端清除） */
async function handleAuthLogout(request, env) {
  return jsonResp({ success: true }, 200, { 'Set-Cookie': 'jpsj_token=; Max-Age=0; Path=/; SameSite=Lax' });
}

/* 头像上传: 经 imgur.la（Chevereto v1 接口，国内可访问）上传，链接存 users.avatar
   注意: 公共 API key 为访客上传，7 天后自动删除；注册 imgur.la 账号取个人 key
   填到 IMGUR_LA_KEY 环境变量即可永久保存。 */
async function handleAvatarUpload(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  const key = env.IMGUR_LA_KEY || '89bf00be2f91e3e5c74ea050d5b1d3f3';
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return jsonResp({ success: false, error: '请选择图片' }, 400);
    if (file.size > 2 * 1024 * 1024) return jsonResp({ success: false, error: '头像不能超过 2MB' }, 400);
    if (!/^image\//.test(file.type || '')) return jsonResp({ success: false, error: '仅支持图片文件' }, 400);

    const up = new FormData();
    up.append('source', file, file.name || 'avatar.png');
    const r = await fetch('https://imgur.la/api/1/upload', {
      method: 'POST',
      headers: { 'X-API-Key': key },
      body: up
    });
    const d = await r.json();
    if (!d || d.status_code !== 200 || !d.image || !d.image.url) {
      return jsonResp({ success: false, error: '图床返回异常: ' + ((d && d.error && d.error.message) || r.status) }, 502);
    }
    const link = String(d.image.url).replace(/^http:\/\//i, 'https://');
    await env.DB.prepare('UPDATE users SET avatar=? WHERE id=?').bind(link, user.id).run();
    return jsonResp({ success: true, avatar: link });
  } catch (e) {
    return jsonResp({ success: false, error: e.message || '上传失败' }, 500);
  }
}

/* ================= 管理员 · 用户管理 ================= */

async function handleAdminUsers(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  if (user.role !== 'admin') return jsonResp({ success: false, error: '无权限' }, 403);
  try {
    const { results } = await env.DB.prepare(
      'SELECT u.id, u.email, u.role, u.email_verified, u.banned, u.created_at, u.avatar, ' +
      '(SELECT COUNT(*) FROM words w WHERE w.user_id=u.id) AS word_count ' +
      'FROM users u ORDER BY u.id DESC'
    ).all();
    return jsonResp({ success: true, data: results });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleAdminBan(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  if (user.role !== 'admin') return jsonResp({ success: false, error: '无权限' }, 403);
  try {
    const { id, banned } = await request.json();
    const uid = Number(id);
    if (!uid) return jsonResp({ success: false, error: '缺少用户ID' }, 400);
    if (uid === user.id) return jsonResp({ success: false, error: '不能封禁自己' }, 400);
    await env.DB.prepare('UPDATE users SET banned=? WHERE id=?').bind(banned ? 1 : 0, uid).run();
    return jsonResp({ success: true, message: banned ? '已封禁' : '已解封' });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleAdminDelete(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  if (user.role !== 'admin') return jsonResp({ success: false, error: '无权限' }, 403);
  try {
    const { id } = await request.json();
    const uid = Number(id);
    if (!uid) return jsonResp({ success: false, error: '缺少用户ID' }, 400);
    if (uid === user.id) return jsonResp({ success: false, error: '不能删除自己的账号' }, 400);
    const u = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first();
    if (!u) return jsonResp({ success: false, error: '用户不存在' }, 404);
    /* 连带清理: 云盘 KV 文件 + 元数据 + 单词 + 验证码 + 账号 */
    const files = await env.DB.prepare('SELECT id, chunk_count FROM drive_files WHERE user_id=?').bind(uid).all();
    for (const f of files.results || []) {
      await Promise.all(driveAllKeys(f.id, driveChunkCount(f.chunk_count)).map(k => env.FILES_KV.delete(k)));
    }
    await env.DB.prepare('DELETE FROM drive_files WHERE user_id=?').bind(uid).run();
    await env.DB.prepare('DELETE FROM words WHERE user_id=?').bind(uid).run();
    await env.DB.prepare('DELETE FROM email_codes WHERE email=?').bind(u.email).run();
    await env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid).run();
    return jsonResp({ success: true, message: '账号已删除' });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleAdminPassword(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  if (user.role !== 'admin') return jsonResp({ success: false, error: '无权限' }, 403);
  try {
    const { id, password } = await request.json();
    const uid = Number(id);
    const pw = String(password || '');
    if (!uid) return jsonResp({ success: false, error: '缺少用户ID' }, 400);
    if (pw.length < 6 || pw.length > 72) return jsonResp({ success: false, error: '密码长度需在 6-72 位之间' }, 400);
    const salt = randHex(32);
    const hash = await pbkdf2(pw, salt);
    await env.DB.prepare('UPDATE users SET password_hash=? WHERE id=?').bind(salt + ':' + hash, uid).run();
    return jsonResp({ success: true, message: '密码已重置' });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

/* ================= 英语单词本 ================= */

const WORD_LIMIT = 150;

/* 词典释义推荐: 代理 Youdao suggest, 免客户端 CORS */
async function handleDictSuggest(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 64) return jsonResp({ success: false, data: [] });
  if (!/^[a-z][a-z\-' ]*$/i.test(q)) return jsonResp({ success: false, data: [] });
  try {
    const r = await fetch('https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&cache=false&le=en&q=' + encodeURIComponent(q),
      { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const entries = (d?.data?.entries || [])
      .map(e => ({ word: e.entry, translation: String(e.explain || '').replace(/^[a-z]+\.\s*/i, '') }))
      .filter(e => e.word && e.translation);
    return jsonResp({ success: true, data: entries });
  } catch (e) {
    return jsonResp({ success: true, data: [] });
  }
}

async function handleWordsList(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const { results } = await env.DB.prepare('SELECT id, word, translation, created_at FROM words WHERE user_id=? ORDER BY created_at DESC').bind(user.id).all();
    return jsonResp({ success: true, data: results, count: results.length, limit: WORD_LIMIT });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleWordsAdd(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const { word, translation } = await request.json();
    if (!word || !translation) return jsonResp({ success: false, error: '单词和释义不能为空' }, 400);
    const w = String(word).trim().toLowerCase();
    const t = String(translation).trim();
    if (!w || w.length > 64 || !t || t.length > 200) return jsonResp({ success: false, error: '单词或释义过长' }, 400);
    if (!/^[a-z][a-z\-' ]*$/i.test(w)) return jsonResp({ success: false, error: '单词只能包含英文字母' }, 400);

    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM words WHERE user_id=?').bind(user.id).first();
    if ((row?.c || 0) >= WORD_LIMIT) return jsonResp({ success: false, error: `单词数已达上限 ${WORD_LIMIT} 个` }, 400);
    try {
      await env.DB.prepare('INSERT INTO words (user_id, word, translation, created_at) VALUES (?,?,?,?)').bind(user.id, w, t, Date.now()).run();
      return jsonResp({ success: true, message: '添加成功' });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return jsonResp({ success: false, error: '该单词已存在' }, 400);
      throw e;
    }
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

async function handleWordsDelete(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: '缺少单词ID' }, 400);
    const r = user.role === 'admin'
      ? await env.DB.prepare('DELETE FROM words WHERE id=?').bind(id).run()
      : await env.DB.prepare('DELETE FROM words WHERE id=? AND user_id=?').bind(id, user.id).run();
    if (!r.meta?.changes) return jsonResp({ success: false, error: '单词不存在或无权删除' }, 403);
    return jsonResp({ success: true });
  } catch (e) { return jsonResp({ success: false, error: e.message }, 500); }
}

/* ================= 维护模式 ================= */

async function checkMaintenanceMode(env) {
  try {
    const { results } = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
      .bind('maintenance_mode').all();
    if (results && results.length > 0) return results[0].value === 'true';
    return false;
  } catch (error) {
    console.error('检查维护模式失败:', error);
    return false;
  }
}

/* ================= 倒计时（维护中） ================= */

/* ================= 倒计时 ================= */

async function handleCountdownsAPI(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, title, target_time, created_at FROM countdowns ORDER BY target_time ASC'
    ).all();
    return jsonResp({ success: true, data: results }, 200, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleAddCountdown(request, env) {
  try {
    const { title, target_time } = await request.json();
    if (!title || !target_time) return jsonResp({ success: false, error: '标题和目标时间不能为空' }, 400);
    const ts = new Date(target_time).getTime();
    if (isNaN(ts)) return jsonResp({ success: false, error: '无效的时间格式' }, 400);
    await env.DB.prepare('INSERT INTO countdowns (title, target_time, created_at) VALUES (?, ?, ?)')
      .bind(title, ts, Date.now()).run();
    return jsonResp({ success: true, message: '倒计时添加成功' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDeleteCountdown(request, env) {
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: 'ID 不能为空' }, 400);
    await env.DB.prepare('DELETE FROM countdowns WHERE id = ?').bind(id).run();
    return jsonResp({ success: true, message: '倒计时删除成功' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* ================= 临时云盘 + 风控 ================= */

const DRIVE_PREFIX = 'file:';
const DRIVE_TTL_SECONDS = 12 * 60 * 60;
const DRIVE_MAX_BYTES = 25 * 1024 * 1024;         /* 兼容老页面：multipart 单次上传的硬上限 */

/* ---- 分片存储 ----
 * KV 单值上限 25MiB，大文件只能切开存：file:<id>:<n>，n 从 0 起。
 * 片大小取 24MiB 而不是 25MiB，留 1MiB 余量，别卡在边界上。
 * D1 里 chunk_count = 0 表示老格式单键 file:<id>，不用迁移老数据。 */
const DRIVE_CHUNK_BYTES = 24 * 1024 * 1024;
const DRIVE_MAX_FILE_BYTES = 500 * 1024 * 1024;
const DRIVE_SESSION_PREFIX = 'up:';
const DRIVE_SESSION_TTL = 3600;

/* 免费版 KV 存储 1GB/命名空间，且这个命名空间是和 old-news 共用的。
 * 从这里读的是「云端盘占用」，超了就拒新上传，别等 KV 自己报错。 */
const DRIVE_KV_LIMIT_BYTES = 1024 * 1024 * 1024;
const DRIVE_KV_SOFT_LIMIT_BYTES = 950 * 1024 * 1024;

/* 下载白名单：仅这些无害扩展名可内联预览，其余(含 html/svg/js/xml 等可执行/可渲染类型)
 * 一律 octet-stream + attachment 强制下载，杜绝存储型 XSS。 */
const DRIVE_SAFE_TYPES = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
  mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4',
  mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', ogg:'audio/ogg',
  pdf:'application/pdf'
};

const RL_KEY_BLOCK = 'rl:bl:';
const RL_KEY_COUNT = 'rl:cnt:';
const RL_KEY_BYTES = 'rl:byte:';

function getRateLimitConfig(country) {
  return country === 'CN'
    ? { label: 'CN',    windowSec: 3600, maxCount: 15, maxBytes: 200 * 1024 * 1024, blockSec: 30 * 60 }
    : { label: 'OTHER', windowSec: 3600, maxCount: 6,  maxBytes: 80  * 1024 * 1024, blockSec: 2 * 60 * 60 };
}

async function checkUploadAllowed(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const country = request.cf?.country || 'UNKNOWN';
  const cfg = getRateLimitConfig(country);

  const blocked = await env.FILES_KV.get(RL_KEY_BLOCK + ip, { type: 'json' });
  if (blocked && blocked.until && blocked.until > Date.now()) {
    return { allowed: false, ip, country, cfg, blocked,
      retryAfterSec: Math.ceil((blocked.until - Date.now()) / 1000) };
  }
  const [c, b] = await Promise.all([
    env.FILES_KV.get(RL_KEY_COUNT + ip),
    env.FILES_KV.get(RL_KEY_BYTES + ip)
  ]);
  return { allowed: true, ip, country, cfg,
    curCount: parseInt(c || '0', 10) || 0, curBytes: parseInt(b || '0', 10) || 0 };
}

function recordUpload(env, ctx, ip, fileSize, cfg) {
  const task = (async () => {
    try {
      const [c, b] = await Promise.all([
        env.FILES_KV.get(RL_KEY_COUNT + ip),
        env.FILES_KV.get(RL_KEY_BYTES + ip)
      ]);
      const newCnt = (parseInt(c || '0', 10) || 0) + 1;
      const newBytes = (parseInt(b || '0', 10) || 0) + (fileSize || 0);
      await Promise.all([
        env.FILES_KV.put(RL_KEY_COUNT + ip, String(newCnt), { expirationTtl: cfg.windowSec }),
        env.FILES_KV.put(RL_KEY_BYTES + ip, String(newBytes), { expirationTtl: cfg.windowSec })
      ]);
      if (newCnt > cfg.maxCount || newBytes > cfg.maxBytes) {
        const reason = newCnt > cfg.maxCount ? 'too_many_uploads' : 'too_much_bytes';
        await env.FILES_KV.put(RL_KEY_BLOCK + ip, JSON.stringify({
          reason, region: cfg.label, count: newCnt, bytes: newBytes,
          blockedAt: Date.now(), until: Date.now() + cfg.blockSec * 1000
        }), { expirationTtl: cfg.blockSec });
        console.warn(`[风控] 已封禁 IP=${ip} 区域=${cfg.label} 原因=${reason}`);
      }
    } catch (e) { console.error('风控记录失败:', e); }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(task); else return task;
}

/* ================= 分片存储：公共小工具 ================= */

/* 片数：0 代表「老格式单键、无下标」 */
function driveChunkCount(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
function driveChunkKey(id, i, total) {
  return total > 0 ? DRIVE_PREFIX + id + ':' + i : DRIVE_PREFIX + id;
}
function driveAllKeys(id, total) {
  if (!total) return [DRIVE_PREFIX + id];
  const out = [];
  for (let i = 0; i < total; i++) out.push(DRIVE_PREFIX + id + ':' + i);
  return out;
}
function driveChunkCountForSize(size) {
  return Math.max(1, Math.ceil((Number(size) || 0) / DRIVE_CHUNK_BYTES));
}

/* 片数以 D1 为准（本 worker 的文件元数据都在 D1），chunk_count=0 就是老格式单键 */
async function driveChunkCountOf(env, id) {
  const r = await env.DB.prepare('SELECT chunk_count FROM drive_files WHERE id=?').bind(id).first();
  return driveChunkCount(r && r.chunk_count);
}

/* 云盘占用：只认每份文件的「片 0」（或老格式单键），整份大小记在它的 metadata 里，
 * 非 0 号片不写 metadata，所以不会重复计。命名空间是两个 worker 共用的，这里统计的是两边合计。 */
async function driveUsage(env) {
  let bytes = 0, files = 0, cursor;
  do {
    const page = await env.FILES_KV.list({ prefix: DRIVE_PREFIX, cursor });
    for (const k of page.keys) {
      const rest = k.name.slice(DRIVE_PREFIX.length);
      const colon = rest.indexOf(':');
      if (colon >= 0 && rest.slice(colon + 1) !== '0') continue;
      bytes += Number((k.metadata || {}).size) || 0;
      files++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { bytes, files, limitBytes: DRIVE_KV_LIMIT_BYTES, softLimitBytes: DRIVE_KV_SOFT_LIMIT_BYTES };
}

/* 边取边吐：pull() 由运行时按下游消费速度回调，内存里最多压着一两片。 */
function driveBodyStream(env, id, total, start, end) {
  const size = DRIVE_CHUNK_BYTES;
  let idx = Math.floor(start / size);
  let offset = start - idx * size;
  let remain = end - start + 1;
  return new ReadableStream({
    async pull(controller) {
      if (remain <= 0) { controller.close(); return; }
      try {
        const buf = await env.FILES_KV.get(driveChunkKey(id, idx, total), { type: 'arrayBuffer' });
        if (!buf) throw new Error('分片 ' + idx + ' 丢失或已过期');
        const take = Math.min(remain, buf.byteLength - offset);
        if (take <= 0) throw new Error('分片 ' + idx + ' 长度异常');
        controller.enqueue(new Uint8Array(buf, offset, take));
        remain -= take;
        offset = 0;
        idx++;
        if (remain <= 0) controller.close();
      } catch (e) {
        console.error('[Drive] 分片流出错 id=' + id + ' 片=' + idx + ':', e?.message || e);
        controller.error(e);
      }
    }
  });
}

/* 单段 Range：只认 bytes=a-b / bytes=a- / bytes=-n，多段不接（返回整份即可） */
function driveParseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasA = m[1] !== '', hasB = m[2] !== '';
  if (!hasA && !hasB) return null;
  let start, end;
  if (!hasA) {
    const n = parseInt(m[2], 10);
    if (!n) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasB ? parseInt(m[2], 10) : size - 1;
    if (end > size - 1) end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

async function driveSessionGet(env, id) {
  if (!id) return null;
  try { return await env.FILES_KV.get(DRIVE_SESSION_PREFIX + id, { type: 'json' }); }
  catch (e) { return null; }
}

/* ================= 分片上传：init / chunk / complete / abort =================
 * 为什么不在 Worker 里拆：Worker 请求体上限按 CF 套餐（免费/Pro 100MB）封顶，
 * 内存又只有 128MB，formData + arrayBuffer + 切片拷贝三轮下来实际安全线 60~80MB。
 * 所以由浏览器 File.slice() 切片，每片 ≤24MiB 单独发上来，Worker 只负责存。 */

async function handleDriveUploadInit(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || 'unnamed').slice(0, 200);
    const size = Number(body.size) || 0;
    const type = String(body.type || 'application/octet-stream').slice(0, 120);
    if (!(size > 0)) return jsonResp({ success: false, error: '文件大小无效' }, 400);
    if (size > DRIVE_MAX_FILE_BYTES) return jsonResp({
      success: false, error: `文件 ${(size / 1048576).toFixed(1)}MB 超过单文件 ${DRIVE_MAX_FILE_BYTES / 1048576}MB 上限`
    }, 400);

    const isAdminUpload = user.role === 'admin';

    /* 风控按「声明总大小」一次算清：分片上传是 N 个请求，按请求计数会把 IP 自己封了 */
    let ip = '', rlCfg = null;
    if (!isAdminUpload) {
      const rl = await checkUploadAllowed(env, request);
      ip = rl.ip; rlCfg = rl.cfg;
      if (!rl.allowed) {
        return new Response(JSON.stringify({
          success: false, error: '上传过于频繁，IP 已被临时限制，请稍后再试',
          region: rl.cfg.label, retryAfterSec: rl.retryAfterSec, blockedUntil: rl.blocked?.until
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': String(rl.retryAfterSec || 60) }
        });
      }
      if (rl.curBytes + size > rl.cfg.maxBytes) {
        return jsonResp({
          success: false, error: '本次上传将超过该 IP 在当前时段的总流量配额',
          region: rl.cfg.label, remainBytes: Math.max(0, rl.cfg.maxBytes - rl.curBytes)
        }, 429);
      }
    }

    /* 存储余量：免费版 KV 只有 1GB，还是两个 worker 共用，超了写入会直接失败 */
    const usage = await driveUsage(env);
    if (usage.bytes + size > DRIVE_KV_SOFT_LIMIT_BYTES) {
      return jsonResp({
        success: false,
        error: `云盘空间不足：已用 ${(usage.bytes / 1048576).toFixed(0)}MB / ${(DRIVE_KV_LIMIT_BYTES / 1048576).toFixed(0)}MB，本次还需 ${(size / 1048576).toFixed(0)}MB`,
        usage
      }, 507);
    }

    const id = crypto.randomUUID();
    const chunkCount = driveChunkCountForSize(size);
    const now = Date.now();
    const session = {
      id, name, size, type, chunkCount, userId: user.id, ip, rlCfg,
      admin: !!isAdminUpload, ttlSeconds: isAdminUpload ? 0 : DRIVE_TTL_SECONDS,
      uploadedAt: now, expiresAt: isAdminUpload ? null : now + DRIVE_TTL_SECONDS * 1000
    };
    await env.FILES_KV.put(DRIVE_SESSION_PREFIX + id, JSON.stringify(session), { expirationTtl: DRIVE_SESSION_TTL });

    return jsonResp({
      success: true, id, chunkSize: DRIVE_CHUNK_BYTES, chunkCount,
      expiresAt: session.expiresAt, maxFileBytes: DRIVE_MAX_FILE_BYTES, usage
    });
  } catch (e) {
    console.error('上传初始化失败:', e);
    return jsonResp({ success: false, error: e.message || '上传初始化失败' }, 500);
  }
}

async function handleDriveUploadChunk(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    const idx = parseInt(url.searchParams.get('i'), 10);
    if (!id || !Number.isInteger(idx) || idx < 0) return jsonResp({ success: false, error: '参数不完整' }, 400);

    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已过期，请重新上传' }, 409);
    if (session.userId !== user.id) return jsonResp({ success: false, error: '这不是你的上传会话' }, 403);
    if (idx >= session.chunkCount) return jsonResp({ success: false, error: '分片序号越界' }, 400);

    const buf = await request.arrayBuffer();
    if (!buf.byteLength) return jsonResp({ success: false, error: '分片为空' }, 400);
    if (buf.byteLength > DRIVE_CHUNK_BYTES) return jsonResp({ success: false, error: '分片超过 ' + (DRIVE_CHUNK_BYTES / 1048576) + 'MB' }, 413);
    const expect = Math.min(DRIVE_CHUNK_BYTES, session.size - idx * DRIVE_CHUNK_BYTES);
    if (buf.byteLength !== expect) {
      return jsonResp({ success: false, error: `分片大小不对：期望 ${expect} 字节，收到 ${buf.byteLength} 字节` }, 400);
    }

    /* metadata 只挂在片 0 上：它既是「文件已成型」的凭证，也是用量统计的唯一出处。
     * 上传中途放弃的残留片没有片 0，过期后由 TTL 自己清掉（永久文件的残留片要等 abort 或人工清）。 */
    const opts = {};
    if (idx === 0) {
      opts.metadata = {
        name: session.name, size: session.size, type: session.type,
        uploadedAt: session.uploadedAt, permanent: !!session.admin, guest: false,
        expiresAt: session.expiresAt, chunkCount: session.chunkCount
      };
    }
    if (session.ttlSeconds) opts.expirationTtl = session.ttlSeconds;
    await env.FILES_KV.put(DRIVE_PREFIX + id + ':' + idx, buf, opts);
    return jsonResp({ success: true, i: idx });
  } catch (e) {
    console.error('分片上传失败:', e);
    return jsonResp({ success: false, error: e.message || '分片上传失败' }, 500);
  }
}

async function handleDriveUploadComplete(request, env, ctx) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '');
    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已过期，请重新上传' }, 409);
    if (session.userId !== user.id) return jsonResp({ success: false, error: '这不是你的上传会话' }, 403);

    /* 片是否到齐。KV 最终一致，同机房立即可见，但网络抖动时给两次重试再判死刑。 */
    const prefix = DRIVE_PREFIX + id + ':';
    let missing = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = new Set();
      let cursor;
      do {
        const page = await env.FILES_KV.list({ prefix, cursor });
        for (const k of page.keys) got.add(Number(k.name.slice(prefix.length)));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      missing = [];
      for (let i = 0; i < session.chunkCount; i++) if (!got.has(i)) missing.push(i);
      if (!missing.length) break;
      if (attempt < 2) await new Promise(r => setTimeout(r, 400));
    }
    if (missing.length) {
      return jsonResp({
        success: false, error: '还有分片没传完：' + missing.slice(0, 10).join(', ') + (missing.length > 10 ? ' …' : ''),
        missing
      }, 409);
    }

    await env.DB.prepare('INSERT INTO drive_files (id, user_id, filename, size, mime_type, uploaded_at, chunk_count) VALUES (?,?,?,?,?,?,?)')
      .bind(id, user.id, session.name, session.size, session.type, session.uploadedAt, session.chunkCount).run();

    /* 风控记账走一次（不是一片一次），否则一个 500MB 文件就能把 IP 顶到封禁 */
    if (session.ip && session.rlCfg && !session.admin) recordUpload(env, ctx, session.ip, session.size, session.rlCfg);
    await env.FILES_KV.delete(DRIVE_SESSION_PREFIX + id);

    const usage = await driveUsage(env);
    return jsonResp({
      success: true, id, url: `/api/drive/file/${id}`,
      name: session.name, size: session.size, type: session.type, uploadedAt: session.uploadedAt,
      expiresAt: session.expiresAt, chunkCount: session.chunkCount, usage
    });
  } catch (e) {
    console.error('上传收尾失败:', e);
    return jsonResp({ success: false, error: e.message || '上传收尾失败' }, 500);
  }
}

/* 中途放弃：把已传的片删干净。
 * 会话在 complete 之后就被删了，所以「没有会话」时绝不动手 —— 否则会把一份已完成的文件误删。 */
async function handleDriveUploadAbort(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '');
    const session = await driveSessionGet(env, id);
    if (!session) return jsonResp({ success: false, error: '上传会话不存在或已完成' }, 409);
    if (session.userId !== user.id) return jsonResp({ success: false, error: '这不是你的上传会话' }, 403);
    await Promise.all(driveAllKeys(id, session.chunkCount).map(k => env.FILES_KV.delete(k)));
    await env.FILES_KV.delete(DRIVE_SESSION_PREFIX + id);
    return jsonResp({ success: true });
  } catch (e) {
    return jsonResp({ success: false, error: e.message || '清理失败' }, 500);
  }
}

async function handleDriveUsage(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const usage = await driveUsage(env);
    return jsonResp({ success: true, ...usage });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 兼容老页面：multipart 单次上传（≤25MB，写老格式单键、chunk_count=0） */
async function handleDriveUpload(request, env, ctx) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return jsonResp({ success: false, error: '请选择文件' }, 400);
    if (file.size > DRIVE_MAX_BYTES) return jsonResp({
      success: false, error: `文件 ${(file.size / 1024 / 1024).toFixed(2)}MB 超过 KV 25MB 上限`
    }, 400);

    const isAdminUpload = user.role === 'admin';

    let rl = null;
    if (!isAdminUpload) {
      rl = await checkUploadAllowed(env, request);
      if (!rl.allowed) {
        return new Response(JSON.stringify({
          success: false, error: '上传过于频繁，IP 已被临时限制，请稍后再试',
          region: rl.cfg.label, retryAfterSec: rl.retryAfterSec, blockedUntil: rl.blocked?.until
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': String(rl.retryAfterSec || 60) }
        });
      }
      if (rl.curBytes + file.size > rl.cfg.maxBytes) {
        return jsonResp({
          success: false, error: '本次上传将超过该 IP 在当前时段的总流量配额',
          region: rl.cfg.label, remainBytes: Math.max(0, rl.cfg.maxBytes - rl.curBytes)
        }, 429);
      }
    }

    const id = crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    await env.FILES_KV.put(DRIVE_PREFIX + id, buffer);
    await env.DB.prepare('INSERT INTO drive_files (id, user_id, filename, size, mime_type, uploaded_at) VALUES (?,?,?,?,?,?)')
      .bind(id, user.id, file.name || 'unnamed', file.size, file.type || 'application/octet-stream', Date.now()).run();

    if (!isAdminUpload && rl) recordUpload(env, ctx, rl.ip, file.size, rl.cfg);

    return jsonResp({ success: true, id, url: `/api/drive/file/${id}` });
  } catch (e) {
    console.error('上传失败:', e);
    return jsonResp({ success: false, error: e.message || '上传失败' }, 500);
  }
}

async function handleDriveList(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    let results;
    if (user.role === 'admin') {
      const r = await env.DB.prepare(
        `SELECT f.id, f.filename, f.size, f.mime_type, f.uploaded_at, f.chunk_count, u.email AS owner_email
         FROM drive_files f LEFT JOIN users u ON u.id = f.user_id
         ORDER BY f.uploaded_at DESC`
      ).all();
      results = r.results;
    } else {
      const r = await env.DB.prepare(
        'SELECT id, filename, size, mime_type, uploaded_at, chunk_count FROM drive_files WHERE user_id=? ORDER BY uploaded_at DESC'
      ).bind(user.id).all();
      results = r.results;
    }
    return jsonResp({ success: true, data: results, admin: user.role === 'admin' });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleDriveDownload(id, env, request) {
  try {
    const row = await env.DB.prepare('SELECT filename, mime_type, size, chunk_count FROM drive_files WHERE id=?').bind(id).first();
    if (!row) return new Response('File not found or expired', { status: 404 });
    const size = Number(row.size) || 0;
    if (!size) return new Response('File metadata missing', { status: 404 });
    const total = driveChunkCount(row.chunk_count);
    const safe = encodeURIComponent(row.filename || 'file');
    const ext = String(row.filename || '').split('.').pop().toLowerCase();
    const safeType = DRIVE_SAFE_TYPES[ext];
    const base = {
      'Content-Type': safeType || 'application/octet-stream',
      'Content-Disposition': `${safeType ? 'inline' : 'attachment'}; filename*=UTF-8''${safe}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
      'Accept-Ranges': 'bytes'
    };

    /* Range：视频拖动进度条全靠它，不支持的话浏览器只能整份下完才播 */
    const range = driveParseRange(request?.headers.get('Range'), size);
    if (range && range.invalid) {
      return new Response('Range Not Satisfiable', { status: 416, headers: { ...base, 'Content-Range': 'bytes */' + size } });
    }
    if (range) {
      return new Response(driveBodyStream(env, id, total, range.start, range.end), {
        status: 206,
        headers: {
          ...base,
          'Content-Length': String(range.end - range.start + 1),
          'Content-Range': `bytes ${range.start}-${range.end}/${size}`
        }
      });
    }
    return new Response(driveBodyStream(env, id, total, 0, size - 1), {
      headers: { ...base, 'Content-Length': String(size) }
    });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}

async function handleDriveDelete(request, env) {
  const user = await authenticate(request, env);
  if (!user) return jsonResp({ success: false, error: '请先登录' }, 401);
  try {
    const { id } = await request.json();
    if (!id) return jsonResp({ success: false, error: 'ID 不能为空' }, 400);
    /* 片数必须在删 D1 行之前读，删完就查不到了，只剩 KV 里的孤儿分片 */
    const total = await driveChunkCountOf(env, id);
    const r = user.role === 'admin'
      ? await env.DB.prepare('DELETE FROM drive_files WHERE id=?').bind(id).run()
      : await env.DB.prepare('DELETE FROM drive_files WHERE id=? AND user_id=?').bind(id, user.id).run();
    if (!r.meta?.changes) return jsonResp({ success: false, error: '文件不存在或无权删除' }, 403);
    /* KV binding 不支持批量删（只有 REST API 支持），一个文件多少片就删多少次 */
    await Promise.all(driveAllKeys(id, total).map(k => env.FILES_KV.delete(k)));
    return jsonResp({ success: true });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

async function handleRlStatus(request, env) {
  const ip = new URL(request.url).searchParams.get('ip');
  if (!ip) return jsonResp({ success: false, error: '缺少 ip 参数' }, 400);
  const [block, c, b] = await Promise.all([
    env.FILES_KV.get(RL_KEY_BLOCK + ip, { type: 'json' }),
    env.FILES_KV.get(RL_KEY_COUNT + ip),
    env.FILES_KV.get(RL_KEY_BYTES + ip)
  ]);
  return jsonResp({
    success: true, ip, blocked: block || null,
    count: parseInt(c || '0', 10), bytes: parseInt(b || '0', 10)
  });
}

async function handleRlUnblock(request, env) {
  try {
    const { ip } = await request.json();
    if (!ip) return jsonResp({ success: false, error: '缺少 ip' }, 400);
    await Promise.all([
      env.FILES_KV.delete(RL_KEY_BLOCK + ip),
      env.FILES_KV.delete(RL_KEY_COUNT + ip),
      env.FILES_KV.delete(RL_KEY_BYTES + ip)
    ]);
    return jsonResp({ success: true, message: `IP ${ip} 已解封` });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* 重置登录/注册限速。POST /api/rl/auth/reset  Bearer ADMIN_TOKEN
 * body: { key: "login"|"reg"|"all", ip: "1.2.3.4"(可选) }
 *  带 ip → 清该 IP 的认证限速计数; 不带 ip → 按 key 清全部 */
async function handleAuthRlReset(request, env) {
  try {
    const { key = 'all', ip } = await request.json().catch(() => ({}));
    if (!['login', 'reg', 'all'].includes(key)) return jsonResp({ success: false, error: 'key 必须是 login/reg/all' }, 400);
    if (ip) {
      await Promise.all([
        env.FILES_KV.delete('rl:auth:login:' + ip),
        env.FILES_KV.delete('rl:auth:reg:' + ip)
      ]);
      return jsonResp({ success: true, message: `已重置 ${ip} 的认证限速` });
    }
    const prefixes = key === 'all' ? ['rl:auth:login:', 'rl:auth:reg:'] : ['rl:auth:' + key + ':'];
    let cleared = 0;
    for (const p of prefixes) {
      let cursor;
      do {
        const page = await env.FILES_KV.list({ prefix: p, cursor });
        await Promise.all(page.keys.map(k => env.FILES_KV.delete(k.name)));
        cleared += page.keys.length;
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
    }
    return jsonResp({ success: true, message: `已清除 ${cleared} 条认证限速记录` });
  } catch (e) {
    return jsonResp({ success: false, error: e.message }, 500);
  }
}

/* =====================================================================
 *                              页面 HTML
 * ===================================================================== */

function getMainHTML() {
  const body = `
<canvas id="particles"></canvas>
<div class="wrap" style="text-align:center;padding-top:10rem">
  <h1 id="typewriter"><span class="cursor">|</span></h1>
  <p class="lede">建平世纪中学学生资源导航站</p>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr));margin-top:3rem;max-width:48rem;margin-left:auto;margin-right:auto">
    <a class="card press reveal" href="/countdown.html">
      <span class="glare"></span><span class="arrow">→</span>
      <h3>⏰ 倒计时</h3><p>重要时刻，倒数计时</p>
    </a>
    <a class="card press reveal" href="/drive">
      <span class="glare"></span><span class="arrow">→</span>
      <h3>📁 我的云盘</h3><p>个人文件云存储 · 登录后使用</p>
    </a>
    <a class="card press reveal" href="/words">
      <span class="glare"></span><span class="arrow">→</span>
      <h3>📖 英语单词本</h3><p>生词记录 · 每人上限 150 个</p>
    </a>
    <a class="card press reveal" href="/about">
      <span class="glare"></span><span class="arrow">→</span>
      <h3>📋 学校简介</h3><p>上海市建平世纪中学 · 了解我们的学校</p>
    </a>
  </div>
</div>`;

  const extra = `
/* ---- 打字机效果 ---- */
const typeText='建平世纪中学非官方站';
let typeIdx=0,deleting=false,typeEl=document.getElementById('typewriter');
(function typeLoop(){
  if(!deleting){
    if(typeIdx<typeText.length){
      typeEl.innerHTML=typeText.slice(0,++typeIdx)+'<span class="cursor">|</span>';
      setTimeout(typeLoop,150);
    }else{
      setTimeout(()=>{
        document.querySelector('.cursor').style.display='none';
        deleting=true;
        typeLoop();
      },2000);
    }
  }else{
    if(typeIdx>0){
      typeEl.innerHTML=typeText.slice(0,--typeIdx)+'<span class="cursor">|</span>';
      setTimeout(typeLoop,100);
    }else{
      deleting=false;
      document.querySelector('.cursor').style.display='inline-block';
      setTimeout(typeLoop,500);
    }
  }
})();

/* ---- 粒子系统 ---- */
(function(){
  const canvas=document.getElementById('particles');
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  let w,h,particles=[],mouseX=-999,mouseY=-999;
  const N=innerWidth<768?55:95;
  const CONN=110,SURF=65,MOUSE_R=160;

  function resize(){w=canvas.width=innerWidth;h=canvas.height=innerHeight;}
  addEventListener('resize',resize);resize();

  for(let i=0;i<N;i++){
    particles.push({
      x:Math.random()*w,y:Math.random()*h,
      vx:(Math.random()-.5)*.55,vy:(Math.random()-.5)*.55,
      r:Math.random()*2+1.3
    });
  }

  document.addEventListener('pointermove',e=>{mouseX=e.clientX;mouseY=e.clientY},{passive:true});
  document.addEventListener('pointerleave',()=>{mouseX=-999;mouseY=-999});

  function draw(){
    ctx.clearRect(0,0,w,h);
    if(RM.matches)return; // 尊重 reduced-motion
    const isDark=R.dataset.theme==='dark';
    const dotC=isDark?'rgba(190,200,240,0.55)':'rgba(70,80,120,0.45)';
    const lineC=isDark?'rgba(180,200,250,' :'rgba(70,90,140,';
    const surfC=isDark?'rgba(100,140,220,' :'rgba(50,70,130,';

    // 更新位置
    for(const p of particles){
      p.x+=p.vx;p.y+=p.vy;
      if(p.x<-20)p.x=w+20;if(p.x>w+20)p.x=-20;
      if(p.y<-20)p.y=h+20;if(p.y>h+20)p.y=-20;

      // 鼠标吸引
      const mdx=mouseX-p.x,mdy=mouseY-p.y,md=Math.sqrt(mdx*mdx+mdy*mdy);
      if(md<MOUSE_R&&md>1){
        const force=(MOUSE_R-md)/MOUSE_R*.008;
        p.vx+=mdx/md*force;p.vy+=mdy/md*force;
      }
      // 阻尼
      p.vx*=0.999;p.vy*=0.999;

      // 画点
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=dotC;ctx.fill();
    }

    // 连接线 & 三角面
    for(let i=0;i<particles.length;i++){
      const a=particles[i];
      for(let j=i+1;j<particles.length;j++){
        const b=particles[j];
        const dx=a.x-b.x,dy=a.y-b.y,dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<CONN){
          const alpha=(1-dist/CONN)*0.18;
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);
          ctx.strokeStyle=lineC+alpha.toFixed(3)+')';ctx.lineWidth=0.6;ctx.stroke();

          // 三角面
          if(dist<SURF){
            for(let k=j+1;k<particles.length;k++){
              const c=particles[k];
              const da=Math.sqrt((a.x-c.x)**2+(a.y-c.y)**2);
              const db=Math.sqrt((b.x-c.x)**2+(b.y-c.y)**2);
              if(da<SURF&&db<SURF){
                const sa=Math.min(1-dist/SURF,1-da/SURF,1-db/SURF)*0.07;
                ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);ctx.closePath();
                ctx.fillStyle=surfC+sa.toFixed(3)+')';ctx.fill();
              }
            }
          }
        }
      }
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();`;

  return page('建平世纪中学非官方站', body, extra);
}



function getAboutHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center">
    <h1 style="margin-bottom:1.2rem">上海市建平世纪中学</h1>
    <p class="lede" style="margin-bottom:2.5rem">浦东新区实验性示范性高中 · 建平教育集团成员校</p>
  </div>

  <div class="card">
    <h3>🏫 学校概况</h3>
    <p style="margin-top:.6rem">上海市建平世纪中学创办于<strong>2000年7月</strong>，是一所公立全日制完全中学，现为<strong>浦东新区实验性示范性高中</strong>，隶属于上海建平教育集团。学校位于浦东新区玉兰路356号，地处浦东行政文化中心，毗邻世纪公园和上海科技馆，占地55亩，是"上海市花园单位"。</p>
    <p style="margin-top:.6rem">现有初高中约38个教学班，学生1600余人，教职工150余名，其中特级教师1名、高级教师28名，区学科带头人及骨干教师21名。</p>
  </div>

  <div class="card">
    <h3>🎯 办学理念</h3>
    <p style="margin-top:.6rem">学校秉持<strong>"构建和谐奋进充实幸福的学习共同体"</strong>的办学理念，以<strong>"崇新勤行"</strong>为校训，致力于让学校成为师生体验成功的乐园。</p>
  </div>

  <div class="card">
    <h3>🔬 创客教育特色</h3>
    <p style="margin-top:.6rem">学校以<strong>创客教育</strong>为核心特色，建有五间总面积约380平方米的创客工坊——<strong>"匠新坊"</strong>，配备3D打印、激光切割、机器人等先进设备。课程涵盖科创、文创、思创、艺创四大类别，每年举办文创节和科创节两大校园品牌活动。</p>
  </div>

  <div class="card">
    <h3>🌱 多元发展</h3>
    <p style="margin-top:.6rem">学校开设近60门校本选修课，涵盖生活、艺术、科技、体育等领域。在生物科技教育、心理健康教育方面具有传统优势，是上海市心理健康教育示范校。学校推行"四个一"生活作业德育实践课程，培养全面发展的新时代学子。</p>
  </div>

  <div class="card">
    <h3>🏆 主要荣誉</h3>
    <p style="margin-top:.6rem">上海市安全文明校园 · 上海市依法治校示范校 · 上海市心理健康教育示范校 · 上海市行为规范示范校 · 浦东新区文明单位 · 浦东新区绿色学校 · 上海市普通高中新课程新教材实施研究与实践项目学校</p>
  </div>

  <div style="text-align:center;margin-top:2rem">
    <p style="color:var(--dim);font-size:.85rem">📍 上海市浦东新区玉兰路356号</p>
  </div>
</div>`;
  return page('学校简介 | 建平世纪中学', body);
}

function get404HTML() {
  return page('404 - 页面未找到 | 建平世纪中学', `
<div class="wrap" style="text-align:center;padding-top:12rem">
  <div class="card" style="max-width:32rem;margin:0 auto;padding:3rem 2rem">
    <div style="font-size:5rem;margin-bottom:1rem;line-height:1">🔍</div>
    <div style="font-size:6rem;font-weight:700;letter-spacing:-.04em;line-height:1;background:linear-gradient(135deg,var(--a),var(--b));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">404</div>
    <h2 style="font-size:1.5rem;font-weight:600;margin:.8rem 0">页面未找到</h2>
    <p class="lede" style="margin-bottom:2rem">抱歉，您访问的页面不存在或已被移除。</p>
    <div style="display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap">
      <a href="/" class="btn p press">🏠 返回首页</a>
      <a href="/countdown.html" class="btn press">⏰ 倒计时</a>
    </div>
  </div>
</div>`, '', 404);
}

function getCountdownHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center;margin-bottom:2rem"><h1>⏰ 倒计时</h1><p>重要时刻，倒数计时</p></div>
  <div id="countdownGrid" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(340px,1fr))"></div>
  <div style="text-align:center;margin-top:2rem"><button class="btn p press" onclick="openAdminPanel()">➕ 管理倒计时</button></div>
</div>
<div id="adminPanel" style="position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.32);backdrop-filter:blur(2px);opacity:0;pointer-events:none;display:flex;align-items:center;justify-content:center;transition:opacity .3s linear" onclick="closeAdminPanel()">
  <div style="background:var(--glass);border:1px solid var(--line);box-shadow:var(--shH),inset 0 1px 0 var(--edge);backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);border-radius:1.6rem;padding:2rem;width:min(32rem,90%);max-height:85vh;overflow:auto;transform:scale(.94);transition:transform .3s cubic-bezier(.22,.61,.36,1)" onclick="event.stopPropagation()">
    <button class="btn press" style="position:absolute;top:.8rem;right:.8rem" onclick="closeAdminPanel()">×</button>
    <h2 style="margin-bottom:1.5rem;font-size:1.2rem;font-weight:600">管理倒计时</h2>
    <div id="msgBox" style="padding:.6rem 1rem;border-radius:.5rem;margin-bottom:1rem;font-size:.82rem;display:none"></div>
    <div style="margin-bottom:1rem"><label style="display:block;font-size:.78rem;font-weight:600;color:var(--dim);margin-bottom:.3rem">管理员密钥</label><input type="password" id="adminToken" class="srch" placeholder="ADMIN_TOKEN"></div>
    <div style="margin-bottom:1rem"><label style="display:block;font-size:.78rem;font-weight:600;color:var(--dim);margin-bottom:.3rem">倒计时标题</label><input type="text" id="countdownTitle" class="srch"></div>
    <div style="margin-bottom:1rem"><label style="display:block;font-size:.78rem;font-weight:600;color:var(--dim);margin-bottom:.3rem">目标日期时间</label><input type="datetime-local" id="targetTime" class="srch"></div>
    <button class="btn p press" style="width:100%;margin-top:.5rem" onclick="addCountdown()">添加倒计时</button>
  </div>
</div>

`;
  const extra = `
let countdowns=[],intervalIds=[];
async function loadCountdowns(){
  try{const r=await fetch('/api/countdowns'),d=await r.json();
    if(d.success){countdowns=d.data;render();}
  }catch(e){console.error(e)}
}
function clearAll(){intervalIds.forEach(i=>clearInterval(i));intervalIds=[]}
function render(){
  clearAll();const g=document.getElementById('countdownGrid');
  if(!countdowns.length){g.innerHTML='<div class="empty" style="grid-column:1/-1;padding:4rem 0"><div style="font-size:3rem">⏰</div><h2>还没有倒计时</h2><p>点击下方按钮添加吧</p></div>';return}
  g.innerHTML='';
  countdowns.forEach(c=>{
    const now=Date.now();
    const card=document.createElement('div');card.className='countdown-card';
    if(c.target_time<=now){
      card.innerHTML='<button class="btn press" style="position:absolute;top:.5rem;right:.5rem;font-size:.8rem;opacity:.6" onclick="del('+c.id+')">×</button><div style="text-align:center;padding:2rem"><h3>🎉 '+esc(c.title)+'</h3><p>时间已到！</p></div>';
      g.appendChild(card);
    }else{
      card.innerHTML='<button class="btn press" style="position:absolute;top:.5rem;right:.5rem;font-size:.8rem;opacity:.6" onclick="del('+c.id+')">×</button><div style="font-size:1.2rem;font-weight:600;margin-bottom:1rem">'+esc(c.title)+'</div><div id="cd-'+c.id+'" class="flip-clock"></div>';
      g.appendChild(card);startCountdown(c.id,c.target_time);
    }
  });
}
function startCountdown(id,target){
  const c=document.getElementById('cd-'+id);
  const units=[{label:'Days',ids:['d1','d2','d3']},{label:'Hours',ids:['h1','h2']},{label:'Minutes',ids:['m1','m2']},{label:'Seconds',ids:['s1','s2']}];
  let html='';
  units.forEach(u=>{
    html+='<div class="flip-unit"><div class="flip-label">'+u.label+'</div><div class="flip-card-container">';
    u.ids.forEach(d=>{
      const k=d+'-'+id;
      html+='<div class="flip-card" id="'+k+'"><div class="flip-card-top"><div class="flip-number" id="'+k+'-ct">0</div></div><div class="flip-card-bottom"><div class="flip-number" id="'+k+'-cb">0</div></div><div class="flip-card-top-flip" id="'+k+'-tf" style="display:none"><div class="flip-number" id="'+k+'-nt">0</div></div><div class="flip-card-bottom-flip" id="'+k+'-bf" style="display:none"><div class="flip-number" id="'+k+'-nb">0</div></div></div>';
    });
    html+='</div></div>';
  });
  c.innerHTML=html;
  function tick(){
    const diff=target-Date.now();
    if(diff<=0){loadCountdowns();return}
    const dd=Math.floor(diff/864e5),hh=Math.floor(diff%864e5/36e5),mm=Math.floor(diff%36e5/6e4),ss=Math.floor(diff%6e4/1e3);
    set('d1-'+id,Math.floor(dd/100));set('d2-'+id,Math.floor(dd%100/10));set('d3-'+id,dd%10);
    set('h1-'+id,Math.floor(hh/10));set('h2-'+id,hh%10);
    set('m1-'+id,Math.floor(mm/10));set('m2-'+id,mm%10);
    set('s1-'+id,Math.floor(ss/10));set('s2-'+id,ss%10);
  }
  tick();intervalIds.push(setInterval(tick,1000));
}
function set(k,v){
  const ct=document.getElementById(k+'-ct'),cb=document.getElementById(k+'-cb');
  if(!ct||!cb)return;
  const cur=parseInt(ct.textContent)||0;
  if(cur===v)return;
  const card=document.getElementById(k),
        tf=document.getElementById(k+'-tf'),bf=document.getElementById(k+'-bf'),
        nt=document.getElementById(k+'-nt'),nb=document.getElementById(k+'-nb');
  if(card.classList.contains('flipping'))return;

  // 翻动层:上半显示 OLD(要翻走的),下半显示 NEW(要翻进来的)
  nt.textContent=cur;
  nb.textContent=v;
  // 静态层:上半立刻切到 NEW(此刻被 top-flip 盖住,看不见);下半保持 OLD,动画末再切
  ct.textContent=v;

  tf.style.display='block';bf.style.display='block';
  card.classList.add('flipping');
  setTimeout(()=>{
    cb.textContent=v;          // 此时 bottom-flip 已落到 0° 盖住它,切换不可见
    tf.style.display='none';
    bf.style.display='none';
    card.classList.remove('flipping');
  },600);
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function openAdminPanel(){const t=localStorage.getItem('admin_token');if(t)document.getElementById('adminToken').value=t;const p=document.getElementById('adminPanel');p.style.opacity='1';p.style.pointerEvents='auto';p.querySelector('div').style.transform='scale(1)'}
function closeAdminPanel(){const p=document.getElementById('adminPanel');p.style.opacity='0';p.style.pointerEvents='none';p.querySelector('div').style.transform='scale(.94)';hideMsg()}
async function addCountdown(){
  const t=document.getElementById('adminToken').value.trim(),title=document.getElementById('countdownTitle').value.trim(),tt=document.getElementById('targetTime').value;
  if(!t)return showMsg('请输入管理员密钥','error');
  if(!title)return showMsg('请输入标题','error');
  if(!tt)return showMsg('请选择目标时间','error');
  try{
    const r=await fetch('/api/countdown/add',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({title,target_time:new Date(tt).toISOString()})});
    const d=await r.json();
    if(d.success){localStorage.setItem('admin_token',t);showMsg('添加成功！','success');document.getElementById('countdownTitle').value='';document.getElementById('targetTime').value='';setTimeout(()=>{closeAdminPanel();loadCountdowns()},1500)}
    else showMsg(d.error||'添加失败','error');
  }catch(e){showMsg('网络错误：'+e.message,'error')}
}
async function del(id){
  if(!confirm('确定删除？'))return;
  const t=localStorage.getItem('admin_token');
  if(!t)return alert('请先在管理面板中输入密钥');
  try{
    const r=await fetch('/api/countdown/delete',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({id})});
    const d=await r.json();
    if(d.success)loadCountdowns();else alert(d.error||'删除失败');
  }catch(e){alert('网络错误：'+e.message)}
}
function showMsg(t,type){const m=document.getElementById('msgBox');m.textContent=t;m.style.display='block';m.style.background=type==='error'?'#fde7e9':'#dff6dd';m.style.borderLeft='4px solid '+(type==='error'?'#a80000':'#107c10');m.style.color=type==='error'?'#a80000':'#0b5a08';setTimeout(hideMsg,5000)}
function hideMsg(){const m=document.getElementById('msgBox');if(m)m.style.display='none'}
loadCountdowns();setInterval(loadCountdowns,30000);
`;
  return page('倒计时 | 建平世纪中学', body, extra);
}

function getDriveHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center;margin-bottom:2rem"><h1>📁 我的云盘</h1><p>登录后上传 · 单文件上限 500MB · 文件仅本人与管理员可见</p></div>
  <div class="card">
    <div id="usageBox" style="display:none">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.4rem">
        <span style="font-size:.85rem;font-weight:600;color:var(--fg)">云盘空间</span>
        <span style="font-size:.75rem;color:var(--dim)" id="usageText">—</span>
      </div>
      <div style="width:100%;height:8px;background:var(--line);border-radius:4px;overflow:hidden">
        <div id="usageBar" style="height:100%;width:0;background:#0078d4;transition:.3s"></div>
      </div>
      <div style="font-size:.7rem;color:var(--dim);margin-top:.3rem">整个 KV 命名空间免费额度 1GB，两个站点共用。</div>
    </div>
    <div id="dropZone" class="drop-zone" onclick="document.getElementById('fileInput').click()">
      <div style="font-size:3rem;margin-bottom:.75rem">☁️</div>
      <div style="font-size:1rem;color:var(--fg);margin-bottom:.25rem" id="dropText">点击或拖拽文件到此处上传</div>
      <div style="font-size:.78rem;color:var(--dim)">最大 500MB</div>
    </div>
    <input type="file" id="fileInput">
    <div style="margin-bottom:1rem;display:flex;gap:8px;align-items:center">
      <button class="btn p press" id="uploadBtn" onclick="upload()">⬆ 上传</button>
      <button class="btn press" style="color:#0078d4" onclick="loadList()">🔄 刷新列表</button>
      <label id="ownOnlyWrap" style="margin:0;display:flex;align-items:center;gap:.3rem;font-size:.78rem;display:none"><input type="checkbox" id="ownOnly" onchange="render()">只看我的</label>
    </div>
    <div class="progress" id="progress" style="display:none"><div class="progress-bar" id="progressBar"></div></div>
    <div id="msg" style="padding:.6rem 1rem;border-radius:.5rem;margin-bottom:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
  </div>
  <div class="card">
    <h2 style="font-size:18px;margin-bottom:16px;color:var(--dim)">文件列表</h2>
    <ul id="fileList" style="list-style:none"></ul>
  </div>
</div>

`;
  const extra = `
const $=id=>document.getElementById(id),dropZone=$('dropZone'),fileInput=$('fileInput');
let pending=null,allFiles=[],isAdmin=false,uploading=false,currentUploadId=null;
/* 分片参数要和后端 new-jpsj-website.js 里的 DRIVE_CHUNK_BYTES / DRIVE_MAX_FILE_BYTES 保持一致 */
const CHUNK_BYTES=24*1024*1024,MAX_FILE_BYTES=500*1024*1024,UPLOAD_CONCURRENCY=3;
['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.add('drag')}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev,e=>{e.preventDefault();dropZone.classList.remove('drag')}));
dropZone.addEventListener('drop',e=>{if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])});
fileInput.addEventListener('change',e=>{if(e.target.files[0])setFile(e.target.files[0])});
function api(path,opts={}){const h={...(opts.headers||{})};const t=getToken();if(t)h['Authorization']='Bearer '+t;return fetch(path,{...opts,headers:h})}
function setFile(f){pending=f;$('dropText').textContent='已选择：'+f.name+' ('+fmtSize(f.size)+')'}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB'}
function fmtTime(ts){if(!ts)return'-';return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
function showMsg(t,type='success'){const m=$('msg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='error'?'#a80000':'#107c10');m.style.color=type==='error'?'#a80000':'#0b5a08';setTimeout(()=>{m.style.display='none'},5000)}
/* 大文件在浏览器里切开再传：Worker 请求体上限 100MB、内存 128MB，整份丢过去必炸。
   init 拿会话 -> 3 路并发传片 -> complete 收尾；任何一步失败就 abort 把已传的片清掉。 */
async function upload(){
  if(!getToken())return showMsg('请先登录','error');
  if(!pending)return showMsg('请先选择文件','error');
  if(!pending.size)return showMsg('文件是空的','error');
  if(pending.size>MAX_FILE_BYTES)return showMsg('文件超过 '+fmtSize(MAX_FILE_BYTES),'error');
  const btn=$('uploadBtn');
  uploading=true;btn.disabled=true;btn.textContent='准备中...';
  $('progress').style.display='block';$('progressBar').style.width='0%';
  let id=null;
  try{
    const init=await api('/api/drive/upload/init',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:pending.name,size:pending.size,type:pending.type||'application/octet-stream'})});
    if(init.status===401)return showMsg('请先登录','error');
    const d=await init.json();
    if(!d.success)return showMsg('✗ '+(d.error||'初始化失败'),'error');
    id=d.id;currentUploadId=id;
    const chunkSize=d.chunkSize,count=d.chunkCount;
    let cursor=0,done=0;
    const nextIndex=()=>cursor<count?cursor++:-1;
    async function sendChunk(i){
      let lastErr=null;
      for(let attempt=1;attempt<=3;attempt++){
        try{
          const blob=pending.slice(i*chunkSize,Math.min((i+1)*chunkSize,pending.size));
          const r=await api('/api/drive/upload/chunk?id='+encodeURIComponent(id)+'&i='+i,
            {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob});
          if(r.status===401)throw new Error('请先登录');
          if(r.ok)return;
          const e=await r.json().catch(()=>({}));
          lastErr=new Error(e.error||('HTTP '+r.status));
          if(r.status<500)throw lastErr;   /* 4xx 是参数/会话问题，重试没意义 */
        }catch(err){lastErr=err}
        if(attempt<3)await new Promise(res=>setTimeout(res,600*attempt));
      }
      throw lastErr||new Error('分片上传失败');
    }
    async function worker(){
      for(let i=nextIndex();i>=0;i=nextIndex()){
        await sendChunk(i);
        done++;$('progressBar').style.width=Math.round(done/count*100)+'%';btn.textContent='上传中 '+done+'/'+count;
      }
    }
    btn.textContent='上传中 0/'+count;
    await Promise.all(Array.from({length:Math.min(UPLOAD_CONCURRENCY,count)},worker));

    btn.textContent='收尾中...';
    const comp=await api('/api/drive/upload/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    const cb=await comp.json();
    if(!cb.success){await abortUpload(id);return showMsg('✗ '+(cb.error||'上传收尾失败'),'error')}
    showMsg('✓ 上传成功！','success');
    pending=null;fileInput.value='';$('dropText').textContent='点击或拖拽文件到此处上传';
    renderUsage(cb.usage);loadList();
  }catch(e){
    if(id)await abortUpload(id);
    showMsg('✗ '+e.message,'error');
  }finally{
    uploading=false;currentUploadId=null;btn.disabled=false;btn.textContent='⬆ 上传';
    setTimeout(()=>{$('progress').style.display='none';$('progressBar').style.width='0'},800);
  }
}
async function abortUpload(id){
  try{await api('/api/drive/upload/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id}),keepalive:true})}catch(e){}
}
/* 中途离开页面会让已传的片变成孤儿（永久上传没有 TTL 兜底），拦一下并顺手清掉 */
window.addEventListener('beforeunload',e=>{if(uploading){e.preventDefault();e.returnValue=''}});
window.addEventListener('pagehide',()=>{if(uploading&&currentUploadId)abortUpload(currentUploadId)});
async function loadUsage(){
  try{
    const r=await api('/api/drive/usage'),d=await r.json();
    if(d.success)renderUsage(d);
  }catch(e){}
}
function renderUsage(u){
  if(!u)return;
  const cap=u.softLimitBytes||u.limitBytes;
  const pct=Math.min(100,Math.round(u.bytes/cap*100));
  $('usageBox').style.display='block';
  $('usageBar').style.width=pct+'%';
  $('usageBar').style.background=pct>=90?'#a80000':(pct>=70?'#ff8c00':'#0078d4');
  $('usageText').textContent=fmtSize(u.bytes)+' / '+fmtSize(u.limitBytes)+'（'+pct+'%）· '+u.files+' 个文件';
}
async function loadList(){
  try{
    const r=await api('/api/drive/list'),d=await r.json();
    if(!d.success){$('fileList').innerHTML='<div class="empty">'+escHtml(d.error||'加载失败')+'</div>';return}
    isAdmin=!!d.admin;allFiles=d.data||[];
    const ow=$('ownOnlyWrap');if(ow)ow.style.display=isAdmin?'flex':'none';
    render();loadUsage();
  }catch(e){$('fileList').innerHTML='<div class="empty">加载失败：'+e.message+'</div>'}
}
function render(){
  const ul=$('fileList');
  if(!allFiles.length){ul.innerHTML='<div class="empty">暂无文件</div>';return}
  let list=allFiles;
  if(isAdmin&&$('ownOnly')&&$('ownOnly').checked)list=allFiles.filter(f=>!f.owner_email);
  if(!list.length){ul.innerHTML='<div class="empty">暂无文件</div>';return}
  ul.innerHTML=list.map(f=>{
    const icon=f.mime_type&&f.mime_type.startsWith('image/')?'🖼️':f.mime_type&&f.mime_type.startsWith('video/')?'🎬':f.mime_type&&f.mime_type.startsWith('audio/')?'🎵':f.mime_type==='application/pdf'?'📄':f.mime_type&&f.mime_type.startsWith('text/')?'📝':'📦';
    const owner=isAdmin?('<span style="font-size:.72rem;color:var(--dim)">'+(f.owner_email||'?')+'</span>'):'';
    const link='/api/drive/file/'+f.id;
    return '<li style="display:flex;align-items:center;gap:.75rem;padding:.75rem;border-bottom:1px solid var(--line)"><div style="font-size:1.5rem">'+icon+'</div><div style="flex:1;min-width:0"><div style="font-size:.9rem;color:var(--fg);font-weight:600;word-break:break-all">'+escHtml(f.filename||'(未命名)')+'</div><div style="font-size:.75rem;color:var(--dim);margin-top:.15rem">'+fmtSize(f.size||0)+(f.chunk_count>1?(' · '+f.chunk_count+' 片'):'')+' · '+fmtTime(f.uploaded_at)+' '+owner+'</div></div><div style="display:flex;gap:.35rem;flex-shrink:0"><a class="btn p press" style="padding:.25rem .6rem;font-size:.75rem" href="'+link+'" target="_blank">查看</a><a class="btn p press" style="padding:.25rem .6rem;font-size:.75rem" href="'+link+'" download="'+escHtml(f.filename||'file')+'">下载</a><button class="btn press" style="padding:.25rem .6rem;font-size:.75rem;color:#a4262c" onclick="copyLink(\\''+link+'\\')">复制链接</button><button class="btn press" style="padding:.25rem .6rem;font-size:.75rem;color:#a4262c" onclick="del(\\''+f.id+'\\')">删除</button></div></li>';
  }).join('');
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function copyLink(p){const f=location.origin+p;navigator.clipboard.writeText(f).then(()=>showMsg('已复制：'+f,'success'),()=>showMsg('复制失败','error'))}
async function del(id){
  if(!confirm('确定删除？'))return;
  try{
    const r=await api('/api/drive/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
    if(r.status===401)return showMsg('请先登录','error');
    const d=await r.json();
    if(d.success){showMsg('已删除','success');loadList()}
    else showMsg('删除失败：'+(d.error||''),'error');
  }catch(e){showMsg('请求失败：'+e.message,'error')}
}
loadList();
`;
  return page('我的云盘 | 建平世纪中学', body, extra);
}

function getWordsHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center;margin-bottom:2rem"><h1>📖 英语单词本</h1><p>记录不认识的单词 · 每人上限 150 个</p></div>
  <div class="card">
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <div class="sug-wrap" style="flex:1;min-width:10rem">
        <input type="text" id="wWord" placeholder="单词，如 abandon" autocomplete="off">
        <div class="sug-box" id="suggestBox"></div>
      </div>
      <input type="text" id="wTrans" placeholder="释义，如 放弃" style="flex:1;min-width:10rem">
      <button class="btn p press" id="addBtn" onclick="addWord()">＋ 添加</button>
      <button class="btn press" onclick="startQuiz()">🎲 随机测试</button>
    </div>
    <div style="display:flex;align-items:center;gap:.5rem;margin-top:1rem;flex-wrap:wrap">
      <input type="text" id="wSearch" class="srch" style="margin:0;flex:1" placeholder="🔍 搜索单词/释义...">
      <span id="wCount" style="font-size:.78rem;color:var(--dim);white-space:nowrap"></span>
    </div>
    <div id="wMsg" style="padding:.6rem 1rem;border-radius:.5rem;margin-top:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
  </div>
  <div class="card">
    <div id="wordGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.6rem"></div>
  </div>
  <div class="card" id="quizCard" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
      <h3 style="font-size:1rem">🎲 随机测试</h3>
      <label style="margin:0;display:flex;align-items:center;gap:.3rem;font-size:.78rem"><input type="checkbox" id="quizDir">中译英</label>
    </div>
    <div id="quizBox"></div>
  </div>
</div>

`;
  const extra = `
const $=id=>document.getElementById(id);
async function api(path,opts={}){const h={...(opts.headers||{})};const t=getToken();if(t)h['Authorization']='Bearer '+t;if(opts.body)h['Content-Type']='application/json';const r=await fetch(path,{...opts,headers:h});return r.json()}
function showMsg(t,type){const m=$('wMsg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='err'?'#a80000':'#107c10');m.style.color=type==='err'?'#a80000':'#0b5a08';setTimeout(()=>{m.style.display='none'},4000)}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
let words=[],limit=150;
async function init(){
  if(!getToken()){ $('wordGrid').innerHTML='<div class="empty" style="grid-column:1/-1">请先<a class="btn press" href="/login" style="display:inline-block;margin:0 .4rem">登录</a>后使用单词本</div>'; return; }
  await load();
  $('wSearch').addEventListener('input',render);
}
async function load(){
  try{
    const d=await api('/api/words/list');
    if(d.success){words=d.data||[];limit=d.limit||150;$('wCount').textContent=words.length+' / '+limit;render()}
    else showMsg(d.error||'加载失败','err');
  }catch(e){showMsg('加载失败','err')}
}
function render(){
  const q=$('wSearch').value.trim().toLowerCase();
  const list=q?words.filter(w=>w.word.includes(q)||w.translation.includes(q)):words;
  const g=$('wordGrid');
  if(!list.length){g.innerHTML='<div class="empty" style="grid-column:1/-1">'+(words.length?'没有匹配的单词':'还没有单词，先添加一个吧')+'</div>';return}
  g.innerHTML=list.map(w=>
    '<div class="card press" style="padding:.9rem 1rem;display:flex;flex-direction:column;gap:.3rem">'+
    '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:1.05rem;font-weight:600">'+escHtml(w.word)+'</span><button class="btn press" style="padding:.15rem .5rem;font-size:.7rem;color:#a4262c" onclick="del('+w.id+')">删除</button></div>'+
    '<span style="font-size:.82rem;color:var(--dim)">'+escHtml(w.translation)+'</span></div>'
  ).join('');
}
async function addWord(){
  const w=$('wWord').value.trim(),t=$('wTrans').value.trim();
  if(!w||!t)return showMsg('请输入单词和释义','err');
  try{
    const d=await api('/api/words/add',{method:'POST',body:JSON.stringify({word:w,translation:t})});
    if(d.success){$('wWord').value='';$('wTrans').value='';showMsg('已添加');load()}
    else showMsg(d.error||'添加失败','err');
  }catch(e){showMsg('添加失败','err')}
}
async function del(id){
  if(!confirm('删除该单词？'))return;
  try{
    const d=await api('/api/words/delete',{method:'POST',body:JSON.stringify({id})});
    if(d.success)load();else showMsg(d.error||'删除失败','err');
  }catch(e){showMsg('删除失败','err')}
}

/* ---------- 输入自动推荐释义 ---------- */
const jsq=s=>String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'&quot;');
let sugTimer=null;
$('wWord').addEventListener('input',()=>{clearTimeout(sugTimer);sugTimer=setTimeout(doSuggest,300)});
async function doSuggest(){
  const q=$('wWord').value.trim(),box=$('suggestBox');
  if(!q){box.style.display='none';return}
  try{
    const r=await fetch('/api/dict/suggest?q='+encodeURIComponent(q));
    const d=await r.json();
    if(!d.success||!d.data.length){box.style.display='none';return}
    box.innerHTML=d.data.map(s=>
      '<div class="sug-item" onclick="pickSug(\\''+jsq(s.word)+'\\',\\''+jsq(s.translation)+'\\')"><b>'+escHtml(s.word)+'</b><span>'+escHtml(s.translation)+'</span></div>'
    ).join('');
    box.style.display='block';
  }catch(e){box.style.display='none'}
}
function pickSug(w,t){$('wWord').value=w;$('wTrans').value=t;$('suggestBox').style.display='none'}
document.addEventListener('click',e=>{if(!e.target.closest('.sug-wrap'))$('suggestBox').style.display='none'});

/* ---------- 随机测试 ---------- */
let quiz=null,qIdx=0,qRight=0,qWrong=0,qDir=0;
function startQuiz(){
  if(!words.length)return showMsg('还没有单词，先添加再测试','err');
  let pool=words.map(w=>({...w,wrong:0}));
  for(let i=pool.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]]}
  quiz=pool.slice(0,20);
  qIdx=0;qRight=0;qWrong=0;qDir=$('quizDir').checked?1:0;
  const card=$('quizCard');card.style.display='';card.scrollIntoView({behavior:'smooth',block:'center'});
  renderQuiz();
}
function renderQuiz(){
  const q=quiz[qIdx],box=$('quizBox');
  if(!q){
    const wrong=quiz.filter(w=>w.wrong).length;
    box.innerHTML='<div style="text-align:center;padding:1rem"><h3 style="margin-bottom:.5rem">本轮完成</h3>'+
      '<p style="color:var(--dim)">认识 <b style="color:#107c10">'+qRight+'</b> 个 · 不认识 <b style="color:#a80000">'+qWrong+'</b> 个 / 共 '+quiz.length+' 个</p>'+
      '<div style="display:flex;gap:.5rem;justify-content:center;margin-top:1rem">'+
      '<button class="btn p press" onclick="startQuiz()">再来一轮</button>'+
      (wrong?('<button class="btn press" onclick="retryWrong()">只测不认识的 '+wrong+' 个</button>'):'')+
      '</div></div>';
    return;
  }
  const show=qDir===0?q.word:q.translation;
  const ans =qDir===0?q.translation:q.word;
  box.innerHTML='<div style="text-align:center;padding:1rem">'+
    '<div style="font-size:.75rem;color:var(--dim);margin-bottom:.5rem">'+(qIdx+1)+' / '+quiz.length+'</div>'+
    '<div style="font-size:1.6rem;font-weight:640;letter-spacing:-.02em;word-break:break-all">'+escHtml(show)+'</div>'+
    '<div id="quizAns" style="font-size:1rem;color:var(--dim);margin-top:.6rem;display:none">'+escHtml(ans)+'</div>'+
    '<div id="quizBtns" style="display:flex;gap:.5rem;justify-content:center;margin-top:1.2rem"><button class="btn press" onclick="showAns()">👁 显示答案</button></div>'+
    '</div>';
}
function showAns(){
  document.getElementById('quizAns').style.display='';
  document.getElementById('quizBtns').innerHTML='<button class="btn p press" style="background:#34c759" onclick="mark(1)">✓ 认识</button><button class="btn press" style="color:#ff3b30" onclick="mark(0)">✗ 不认识</button>';
}
function mark(ok){if(ok)qRight++;else{qWrong++;quiz[qIdx].wrong=1}qIdx++;renderQuiz()}
function retryWrong(){
  const wrong=quiz.filter(w=>w.wrong).map(w=>({...w,wrong:0}));
  if(!wrong.length)return renderQuiz();
  quiz=wrong;qIdx=0;qRight=0;qWrong=0;renderQuiz();
}
/* 中译英开关中途立即生效 */
$('quizDir').addEventListener('change',()=>{if(quiz&&quiz[qIdx]){qDir=$('quizDir').checked?1:0;renderQuiz()}});
init();
`;
  return page('英语单词本 | 建平世纪中学', body, extra);
}

function getAccountHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem;max-width:30rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center;margin-bottom:2rem"><h1>👤 账号设置</h1><p>修改绑定邮箱</p></div>
  <div class="card" style="padding:1.6rem">
    <p id="curEmail" style="font-size:.9rem;color:var(--dim);margin-bottom:1rem">当前邮箱：<b style="color:var(--fg)">-</b></p>
    <label>新邮箱</label>
    <input type="email" id="email" autocomplete="off" placeholder="new@email.com">
    <label>当前密码</label>
    <input type="password" id="pass" autocomplete="current-password" placeholder="用于确认身份">
    <label>新邮箱验证码</label>
    <div style="display:flex;gap:.5rem">
      <input type="text" id="code" inputmode="numeric" maxlength="6" placeholder="6位数字" style="flex:1">
      <button class="btn press" id="sendBtn" onclick="sendCode()" style="white-space:nowrap">发送验证码</button>
    </div>
    <div id="msg" style="padding:.6rem 1rem;border-radius:.5rem;margin-top:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
    <div style="display:flex;justify-content:flex-end;margin-top:1rem">
      <button class="btn p press" onclick="confirmChange()">确认更换邮箱</button>
    </div>
  </div>
</div>
`;
  const extra = `
const $=id=>document.getElementById(id);
function showMsg(t,type){const m=$('msg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='err'?'#a80000':'#107c10');m.style.color=type==='err'?'#a80000':'#0b5a08';setTimeout(()=>{m.style.display='none'},5000)}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function init(){
  if(!getToken()){document.querySelector('.card').innerHTML='<p class="empty" style="padding:1rem;text-align:center">请先<a href="/login" class="btn press" style="display:inline-block;margin:0 .4rem">登录</a></p>';return}
  try{
    const r=await fetch('/api/auth/me',{headers:{Authorization:'Bearer '+getToken()}});
    const d=await r.json();
    if(d.authenticated)$('curEmail').innerHTML='当前邮箱：<b style="color:var(--fg)">'+escHtml(d.user.email)+'</b>';
  }catch(e){}
}
let cdTimer=null;
async function sendCode(){
  const email=$('email').value.trim(),pass=$('pass').value;
  if(!email||!pass)return showMsg('请输入新邮箱和当前密码','err');
  const btn=$('sendBtn');btn.disabled=true;
  try{
    const r=await fetch('/api/auth/change-email',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify({email,password:pass})});
    const d=await r.json();
    if(d.success){showMsg(d.message||'验证码已发送');let n=60;btn.textContent=n+'s';cdTimer=setInterval(()=>{n--;if(n<=0){clearInterval(cdTimer);btn.textContent='发送验证码';btn.disabled=false}else btn.textContent=n+'s'},1000)}
    else showMsg(d.error||'发送失败','err');
  }catch(e){showMsg('网络错误','err')}
  finally{if(!cdTimer)btn.disabled=false}
}
async function confirmChange(){
  const email=$('email').value.trim(),code=$('code').value.trim();
  if(!email||!code)return showMsg('请输入新邮箱和验证码','err');
  try{
    const r=await fetch('/api/auth/verify-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,code,purpose:'change_email'})});
    const d=await r.json();
    if(d.success){showMsg('邮箱已更换，请重新登录');clearToken();setTimeout(()=>location.href='/login',1200)}
    else showMsg(d.error||'验证失败','err');
  }catch(e){showMsg('网络错误','err')}
}
init();
`;
  return page('账号设置 | 建平世纪中学', body, extra);
}

function getAdminHTML() {
  const body = `
<div class="wrap" style="padding-top:5rem">
  <a href="/" class="back press">← 返回首页</a>
  <div style="text-align:center;margin-bottom:2rem"><h1>🛡 用户管理</h1><p>封禁 / 解封 / 删除账号 · 重置密码</p></div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h2 style="font-size:18px;color:var(--dim)">全部用户</h2>
      <button class="btn press" onclick="loadUsers()">🔄 刷新</button>
    </div>
    <div id="msg" style="padding:.6rem 1rem;border-radius:.5rem;margin-bottom:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
    <div id="userList"><div class="empty">加载中...</div></div>
  </div>
</div>
`;
  const extra = `
const $=id=>document.getElementById(id);
function showMsg(t,type){const m=$('msg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='err'?'#a80000':'#107c10');m.style.color=type==='err'?'#a80000':'#0b5a08';setTimeout(()=>{m.style.display='none'},4000)}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function fmt(ts){return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}
async function api(path,opts={}){const h={...(opts.headers||{})};const t=getToken();if(t)h['Authorization']='Bearer '+t;if(opts.body)h['Content-Type']='application/json';const r=await fetch(path,{...opts,headers:h});return r.json()}
async function init(){
  if(!getToken()){$('userList').innerHTML='<div class="empty">请先<a class="btn press" href="/login" style="display:inline-block;margin:0 .4rem">登录</a></div>';return}
  try{
    const me=await api('/api/auth/me');
    if(!me.authenticated){$('userList').innerHTML='<div class="empty">请先登录</div>';return}
    if(me.user.role!=='admin'){$('userList').innerHTML='<div class="empty">无管理员权限</div>';return}
    window._myId=me.user.id;
    await loadUsers();
  }catch(e){$('userList').innerHTML='<div class="empty">加载失败</div>'}
}
async function loadUsers(){
  const box=$('userList');box.innerHTML='<div class="empty">加载中...</div>';
  try{
    const d=await api('/api/admin/users');
    if(!d.success){box.innerHTML='<div class="empty">'+escHtml(d.error||'加载失败')+'</div>';return}
    if(!d.data.length){box.innerHTML='<div class="empty">暂无用户</div>';return}
    box.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.8rem"><thead><tr style="text-align:left;color:var(--dim)"><th style="padding:.4rem">ID</th><th style="padding:.4rem">邮箱</th><th style="padding:.4rem">角色</th><th style="padding:.4rem">单词</th><th style="padding:.4rem">注册时间</th><th style="padding:.4rem">状态</th><th style="padding:.4rem">操作</th></tr></thead><tbody>'+
      d.data.map(u=>'<tr style="border-top:1px solid var(--line,#ffffff22)"><td style="padding:.4rem">'+u.id+'</td>'+
        '<td style="padding:.4rem">'+escHtml(u.email)+(u.id===window._myId?' <span style="color:#107c10">(我)</span>':'')+'</td>'+
        '<td style="padding:.4rem">'+((u.role==='admin')?'<b style="color:#c50f1e">管理员</b>':'用户')+'</td>'+
        '<td style="padding:.4rem">'+u.word_count+'</td>'+
        '<td style="padding:.4rem;white-space:nowrap">'+fmt(u.created_at)+'</td>'+
        '<td style="padding:.4rem">'+(u.banned?'<b style="color:#a80000">已封禁</b>':'<span style="color:#107c10">正常</span>')+'</td>'+
        '<td style="padding:.4rem;white-space:nowrap">'+
          '<button class="btn press" style="padding:.15rem .5rem;font-size:.7rem;margin-right:.3rem;color:'+(u.banned?'#107c10':'#a80000')+'" onclick="toggleBan('+u.id+','+(u.banned?0:1)+')">'+(u.banned?'解封':'封禁')+'</button>'+
          '<button class="btn press" style="padding:.15rem .5rem;font-size:.7rem;margin-right:.3rem" onclick="resetPw('+u.id+')">重置密码</button>'+
          '<button class="btn press" style="padding:.15rem .5rem;font-size:.7rem;color:#a4262c" onclick="delUser('+u.id+')">删除</button>'+
        '</td></tr>').join('')+'</tbody></table></div>';
  }catch(e){box.innerHTML='<div class="empty">加载失败</div>'}
}
async function toggleBan(id,val){
  if(!confirm(val?'确定封禁该用户？':'确定解封该用户？'))return;
  try{
    const d=await api('/api/admin/users/ban',{method:'POST',body:JSON.stringify({id,banned:val})});
    if(d.success){showMsg(d.message);loadUsers()}else showMsg(d.error||'操作失败','err');
  }catch(e){showMsg('网络错误','err')}
}
async function resetPw(id){
  const pw=prompt('输入新密码（6-72 位）');
  if(pw===null)return;
  try{
    const d=await api('/api/admin/users/password',{method:'POST',body:JSON.stringify({id,password:pw})});
    if(d.success){showMsg(d.message);loadUsers()}else showMsg(d.error||'操作失败','err');
  }catch(e){showMsg('网络错误','err')}
}
async function delUser(id){
  if(!confirm('确定删除该账号？将同时删除其云盘文件、单词等全部数据，且不可恢复！'))return;
  try{
    const d=await api('/api/admin/users/delete',{method:'POST',body:JSON.stringify({id})});
    if(d.success){showMsg(d.message);loadUsers()}else showMsg(d.error||'操作失败','err');
  }catch(e){showMsg('网络错误','err')}
}
init();
`;
  return page('用户管理 | 建平世纪中学', body, extra);
}

function getLoginHTML() {
  const body = `
<div class="wrap" style="padding-top:8rem;max-width:26rem">
  <div style="text-align:center;margin-bottom:1.6rem"><h1 style="font-size:2rem">👋 登录</h1><p class="lede" style="font-size:.9rem">登录后可使用云盘和英语单词本</p></div>
  <div class="card" style="padding:1.6rem">
    <label>邮箱</label>
    <input type="email" id="email" autocomplete="email" placeholder="your@email.com">
    <label>密码</label>
    <input type="password" id="pass" autocomplete="current-password" placeholder="密码" onkeydown="if(event.key==='Enter')login()">
    <div id="msg" style="padding:.6rem 1rem;border-radius:.5rem;margin-top:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
    <div class="row" style="justify-content:space-between;align-items:center">
      <a href="/register" class="back press">没有账号？注册</a>
      <button class="btn p press" onclick="login()">登录</button>
    </div>
  </div>
</div>
`;
  const extra = `
function showMsg(t,type){const m=document.getElementById('msg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='err'?'#a80000':'#107c10');m.style.color=type==='err'?'#a80000':'#0b5a08'}
async function login(){
  const email=document.getElementById('email').value.trim(),pass=document.getElementById('pass').value;
  if(!email||!pass)return showMsg('请输入邮箱和密码','err');
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass})});
    const d=await r.json();
    if(d.success){setToken(d.token);showMsg('登录成功');setTimeout(()=>location.href='/drive',500)}
    else showMsg(d.error||'登录失败','err');
  }catch(e){showMsg('网络错误','err')}
}
`;
  return page('登录 | 建平世纪中学', body, extra);
}

function getRegisterHTML() {
  const body = `
<div class="wrap" style="padding-top:8rem;max-width:26rem">
  <div style="text-align:center;margin-bottom:1.6rem"><h1 style="font-size:2rem">📝 注册</h1><p class="lede" style="font-size:.9rem">验证邮箱后即可登录 · 验证码 60 秒有效</p></div>
  <div class="card" style="padding:1.6rem">
    <label>邮箱</label>
    <input type="email" id="email" autocomplete="email" placeholder="your@163.com">
    <label>密码（6-72 位）</label>
    <input type="password" id="pass" autocomplete="new-password" placeholder="密码">
    <label>确认密码</label>
    <input type="password" id="pass2" autocomplete="new-password" placeholder="再次输入密码">
    <label>邮箱验证码</label>
    <div style="display:flex;gap:.5rem">
      <input type="text" id="code" inputmode="numeric" maxlength="6" placeholder="6位数字" style="flex:1">
      <button class="btn press" id="sendBtn" onclick="sendCode()" style="white-space:nowrap">发送验证码</button>
    </div>
    <div id="msg" style="padding:.6rem 1rem;border-radius:.5rem;margin-top:1rem;font-size:.82rem;display:none;border-left:4px solid"></div>
    <div class="row">
      <a href="/login" class="back press">已有账号？登录</a>
      <button class="btn p press" id="regBtn" onclick="register()">完成注册</button>
    </div>
  </div>
</div>
`;
  const extra = `
function showMsg(t,type){const m=document.getElementById('msg');m.textContent=t;m.style.display='block';m.style.borderLeft='4px solid '+(type==='err'?'#a80000':'#107c10');m.style.color=type==='err'?'#a80000':'#0b5a08'}
let cdTimer=null;
async function sendCode(){
  const email=document.getElementById('email').value.trim(),pass=document.getElementById('pass').value,pass2=document.getElementById('pass2').value;
  if(!email)return showMsg('请输入邮箱','err');
  if(pass.length<6)return showMsg('密码至少 6 位','err');
  if(pass!==pass2)return showMsg('两次密码不一致','err');
  const btn=document.getElementById('sendBtn');
  try{
    const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass})});
    const d=await r.json();
    if(d.success){
      showMsg(d.message||'验证码已发送，60秒内有效');
      let s=60;btn.disabled=true;btn.textContent=s+'s';
      cdTimer=setInterval(()=>{if(--s<=0){clearInterval(cdTimer);btn.disabled=false;btn.textContent='重新发送'}else btn.textContent=s+'s'},1000);
    } else showMsg(d.error||'发送失败','err');
  }catch(e){showMsg('网络错误','err')}
}
async function register(){
  const email=document.getElementById('email').value.trim(),code=document.getElementById('code').value.trim();
  if(!email||!code)return showMsg('请输入邮箱和验证码','err');
  if(!/^\\d{6}$/.test(code))return showMsg('验证码为6位数字','err');
  try{
    const r=await fetch('/api/auth/verify-email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,code})});
    const d=await r.json();
    if(d.success){
      showMsg('验证成功，正在登录...');
      const pass=document.getElementById('pass').value;
      const lr=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:pass})});
      const ld=await lr.json();
      if(ld.success){setToken(ld.token);setTimeout(()=>location.href='/drive',600)}
      else setTimeout(()=>location.href='/login',800);
    } else showMsg(d.error||'验证失败','err');
  }catch(e){showMsg('网络错误','err')}
}
`;
  return page('注册 | 建平世纪中学', body, extra);
}
