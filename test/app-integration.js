// Интеграция: настоящий app.html + настоящий сервер (DOM подменён заглушкой)
const {spawn}=require('child_process'),path=require('path'),os=require('os'),fs=require('fs');
const port=4200+Math.floor(Math.random()*50),dbf=path.join(os.tmpdir(),'int-'+Date.now()+'.sqlite'),base='http://localhost:'+port;
const srv=spawn(process.execPath,[path.join(__dirname,'..','server.js')],{env:{...process.env,PORT:port,DB_FILE:dbf},stdio:'ignore'});
const html=fs.readFileSync(path.join(__dirname,'..','public','app.html'),'utf8'),src=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
let pass=0,bad=0;const ok=(n,c)=>{c?pass++:bad++;console.log((c?'ok   ':'FAIL ')+n)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function mkFetch(cookie){return (u,o={})=>fetch(base+u,{...o,headers:{...(o.headers||{}),Cookie:cookie}})}
async function reg(email,name){const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name,password:'password123'})});return r.headers.get('set-cookie').split(';')[0]}
function mkApp(cookie,ls={}){let click;const out={className:'',textContent:'',innerHTML:'',value:'',focus(){},classList:{toggle(){},add(){},remove(){}}};
 const doc={getElementById:()=>out,addEventListener(t,f){if(t==='click')click=f},documentElement:{style:{},dataset:{}},querySelector:()=>({insertAdjacentHTML(){}})};
 const loc={hash:'',href:''},storage={getItem:k=>ls[k]??null,setItem:(k,v)=>{ls[k]=String(v)},removeItem:k=>{delete ls[k]}};
 const code=src.replace(/mig\(\);mig3\(\);mig4\(\);boot\(\);\s*$/,'')+';return {S:()=>S,boot:boot,R:()=>R,spush:spush,evf:evf,cabinet:cabinet,board:board,SRV:()=>SRV,LV:LV};';
 const f=new Function('document','window','location','localStorage','history','fetch','navigator',code);
 const a=f(doc,{addEventListener(){},scrollTo(){},matchMedia:()=>({matches:false})},loc,storage,{},mkFetch(cookie),{});
 const press=(act,ds)=>click({target:{closest:()=>({dataset:Object.assign({a:act},ds||{}),textContent:'',outerHTML:'',disabled:false})}});
 return {a,out,loc,ls,press}}
(async()=>{for(let i=0;i<50;i++){try{await fetch(base+'/api/me');break}catch{await sleep(100)}}
 const ca=await reg('admin@x.io','Админ'),cu=await reg('anna@x.io','Анна'),cv=await reg('boris@x.io','Борис');
 // 1. вход и загрузка
 const U=mkApp(cu);U.a.boot();await sleep(300);
 ok('приложение определяет пользователя через сервер',U.a.SRV()&&U.a.SRV().email==='anna@x.io');
 ok('после входа открывается главная',/Задания на сегодня/.test(U.out.innerHTML));
 U.a.cabinet();ok('кабинет показывает e-mail и кнопку «Выйти»',/anna@x\.io/.test(U.out.innerHTML)&&/Выйти/.test(U.out.innerHTML));
 // 2. проходим урок → события и прогресс
 U.press('open',{v:'0',l:'0'});U.press('next');let n=0;
 while(U.a.R()&&U.a.R().s<=U.a.R().e.length&&n++<30){const q=U.a.R().e[U.a.R().s-1];if(q[0]==='c')U.press('ans',{i:String(q[3])});else{U.out.value=q[2].split('|')[0];U.press('chk')}U.press('next')}
 ok('урок пройден, XP начислен',U.a.S().xp>0&&U.a.S().done['0-0']===1);
 await sleep(1800);U.a.spush();await sleep(300);
 const api=async(c,u)=>(await fetch(base+u,{headers:{Cookie:c}})).json();
 const pr=await api(cu,'/api/progress');ok('прогресс появился на сервере',pr.data&&pr.data.xp===U.a.S().xp);
 const evs=(await api(ca,'/api/admin/events')).rows;ok('админ видит событие «пройден урок»',evs.some(e=>e.type==='lesson_pass'&&e.email==='anna@x.io'&&JSON.parse(e.data).title));
 const st=await api(ca,'/api/admin/stats');ok('статистика админа учитывает уроки по уровням',st.byLevel.some(x=>x.level==='A1'&&x.n>=1));
 // 3. другое устройство тот же пользователь
 const U2=mkApp(cu);U2.a.boot();await sleep(400);ok('на другом устройстве прогресс подтягивается',U2.a.S().xp===U.a.S().xp&&U2.a.S().done['0-0']===1);
 // 4. другой пользователь в том же браузере
 const shared={el2:JSON.stringify(U.a.S()),el2uid:String(U.a.SRV().id)};const U3=mkApp(cv,shared);U3.a.boot();await sleep(400);
 ok('чужой локальный прогресс не попадает к другому пользователю',U3.a.S().xp===0&&!U3.a.S().done['0-0']);
 // 5. рейтинг
 U.a.board();await sleep(400);ok('рейтинг показывает участников',/Анна/.test(U.out.innerHTML));
 // 6. неавторизованный → редирект
 const G=mkApp('');G.a.boot();await sleep(300);ok('гость перенаправляется на вход',/login=1/.test(G.loc.href));
 console.log(`\nИтого: ${pass} ок, ${bad} ошибок`);srv.kill();for(const e of ['','-wal','-shm'])try{fs.unlinkSync(dbf+e)}catch{}process.exit(bad?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
