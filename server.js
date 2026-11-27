'use strict';
// English Ladder: сервер без внешних зависимостей (Node 22.13+). Запуск: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=+process.env.PORT||3000,SECURE=process.env.COOKIE_SECURE==='1',ADMIN_EMAIL=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const db=new DatabaseSync(process.env.DB_FILE||path.join(__dirname,'data.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,last_login INTEGER,last_seen INTEGER);
CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS progress(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL,xp INTEGER DEFAULT 0,lessons INTEGER DEFAULT 0,words INTEGER DEFAULT 0,streak INTEGER DEFAULT 0,updated INTEGER);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,type TEXT NOT NULL,data TEXT,ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ev_u ON events(user_id,ts);CREATE INDEX IF NOT EXISTS ev_t ON events(ts);`);
const Q=(s,...a)=>db.prepare(s).get(...a),QA=(s,...a)=>db.prepare(s).all(...a),RUN=(s,...a)=>db.prepare(s).run(...a);
const now=()=>Date.now(),sha=s=>crypto.createHash('sha256').update(s).digest('hex'),DAY=864e5;
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,64).toString('hex');
const checkPw=(pw,salt,h)=>{const a=Buffer.from(hashPw(pw,salt),'hex'),b=Buffer.from(h,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const send=(res,code,obj,h={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...h});res.end(JSON.stringify(obj))};
const body=(req,max=1e6)=>new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>max){no({code:413});req.destroy()}else c.push(d)});req.on('end',()=>{try{ok(c.length?JSON.parse(Buffer.concat(c).toString()):{})}catch{no({code:400})}});req.on('error',()=>no({code:400}))});
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')).filter(x=>x[0]).map(([k,...v])=>[k,decodeURIComponent(v.join('='))]));
function session(req){const t=cookies(req).sid;if(!t)return null;const s=Q('SELECT u.*,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.th=?',sha(t));if(!s||s.expires<now()||s.status!=='active')return null;if(!s.last_seen||now()-s.last_seen>6e4)RUN('UPDATE users SET last_seen=? WHERE id=?',now(),s.id);return s}
function login(res,uid,extra={}){const t=crypto.randomBytes(32).toString('hex');RUN('INSERT INTO sessions(th,user_id,expires) VALUES(?,?,?)',sha(t),uid,now()+30*DAY);return {'Set-Cookie':`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30*86400}${SECURE?'; Secure':''}`,...extra}}
const tries=new Map(),limited=k=>{const t=now(),a=(tries.get(k)||[]).filter(x=>t-x<6e5);tries.set(k,a);return a.length>=10},fail=k=>tries.set(k,[...(tries.get(k)||[]),now()]);
const ev=(uid,type,data)=>RUN('INSERT INTO events(user_id,type,data,ts) VALUES(?,?,?,?)',uid,type,data?JSON.stringify(data).slice(0,1000):null,now());
const pub=u=>({id:u.id,email:u.email,name:u.name,role:u.role});
const EMAIL=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const csv=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
const LIST=`SELECT u.id,u.email,u.name,u.role,u.status,u.created_at,u.last_login,u.last_seen,COALESCE(p.xp,0) xp,COALESCE(p.lessons,0) lessons,COALESCE(p.words,0) words,COALESCE(p.streak,0) streak FROM users u LEFT JOIN progress p ON p.user_id=u.id`;

async function api(req,res,u){
  const p=u.pathname,m=req.method;
  if(m!=='GET'){const ct=req.headers['content-type']||'';if(!ct.startsWith('application/json'))return send(res,415,{error:'json_required'});const o=req.headers.origin;if(o){try{if(new URL(o).host!==req.headers.host)return send(res,403,{error:'bad_origin'})}catch{return send(res,403,{error:'bad_origin'})}}}
  const ip=req.socket.remoteAddress||'';
  if(p==='/api/auth/register'&&m==='POST'){const b=await body(req),email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim().slice(0,60),pw=String(b.password||'');
    if(limited('r'+ip))return send(res,429,{error:'too_many'});fail('r'+ip);
    if(!EMAIL.test(email))return send(res,400,{error:'bad_email'});if(!name)return send(res,400,{error:'bad_name'});if(pw.length<8||pw.length>200)return send(res,400,{error:'weak_password'});
    if(Q('SELECT 1 x FROM users WHERE email=?',email))return send(res,409,{error:'email_taken'});
    const salt=crypto.randomBytes(16).toString('hex'),first=!Q('SELECT 1 x FROM users'),role=(ADMIN_EMAIL?email===ADMIN_EMAIL:first)?'admin':'user';
    const id=Number(RUN('INSERT INTO users(email,name,salt,hash,role,created_at,last_seen) VALUES(?,?,?,?,?,?,?)',email,name,salt,hashPw(pw,salt),role,now(),now()).lastInsertRowid);ev(id,'register');
    return send(res,201,pub({id,email,name,role}),login(res,id))}
  if(p==='/api/auth/login'&&m==='POST'){const b=await body(req),email=String(b.email||'').trim().toLowerCase(),k='l'+ip+email;if(limited(k))return send(res,429,{error:'too_many'});
    const u=Q('SELECT * FROM users WHERE email=?',email);if(!u||!checkPw(String(b.password||''),u.salt,u.hash)){fail(k);return send(res,401,{error:'bad_credentials'})}
    if(u.status!=='active')return send(res,403,{error:'blocked'});RUN('UPDATE users SET last_login=?,last_seen=? WHERE id=?',now(),now(),u.id);ev(u.id,'login');return send(res,200,pub(u),login(res,u.id))}
  if(p==='/api/auth/logout'&&m==='POST'){const t=cookies(req).sid;if(t)RUN('DELETE FROM sessions WHERE th=?',sha(t));return send(res,200,{ok:1},{'Set-Cookie':'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'})}
  const me=session(req);if(!me)return send(res,401,{error:'auth'});
  if(p==='/api/me'&&m==='GET')return send(res,200,pub(me));
  if(p==='/api/progress'&&m==='GET'){const r=Q('SELECT data FROM progress WHERE user_id=?',me.id);return send(res,200,{data:r?JSON.parse(r.data):null})}
  if(p==='/api/progress'&&(m==='PUT'||m==='POST')){const b=await body(req),d=b.data,s=b.stats||{};if(!d||typeof d!=='object'||Array.isArray(d))return send(res,400,{error:'bad_data'});
    const n=x=>Math.max(0,Math.min(1e7,Math.floor(+x||0))),str=JSON.stringify(d);if(str.length>600000)return send(res,413,{error:'too_big'});
    RUN('INSERT INTO progress(user_id,data,xp,lessons,words,streak,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,xp=excluded.xp,lessons=excluded.lessons,words=excluded.words,streak=excluded.streak,updated=excluded.updated',me.id,str,n(s.xp),n(s.lessons),n(s.words),n(s.streak),now());return send(res,200,{ok:1})}
  if(p==='/api/events'&&m==='POST'){const b=await body(req);const a=Array.isArray(b.events)?b.events.slice(0,50):[];let c=0;for(const e of a){if(e&&/^[a-z_]{1,30}$/.test(e.type)){ev(me.id,e.type,e.data&&typeof e.data==='object'?e.data:null);c++}}return send(res,200,{saved:c})}
  if(p==='/api/leaderboard'&&m==='GET')return send(res,200,{rows:QA(`SELECT u.id,u.name,p.xp,p.streak,p.words FROM progress p JOIN users u ON u.id=p.user_id WHERE u.status='active' ORDER BY p.xp DESC LIMIT 20`).map(r=>({...r,me:r.id===me.id,id:undefined}))});
  if(p.startsWith('/api/admin')){if(me.role!=='admin')return send(res,403,{error:'forbidden'});
    if(p==='/api/admin/stats'&&m==='GET'){const t=now(),c=(w,a=[])=>Q(`SELECT COUNT(*) n FROM users ${w}`,...a).n;
      return send(res,200,{users:c(''),active1:c('WHERE last_seen>?',[t-DAY]),active7:c('WHERE last_seen>?',[t-7*DAY]),active30:c('WHERE last_seen>?',[t-30*DAY]),new7:c('WHERE created_at>?',[t-7*DAY]),blocked:c("WHERE status='blocked'"),admins:c("WHERE role='admin'"),
      noProgress:Q('SELECT COUNT(*) n FROM users u LEFT JOIN progress p ON p.user_id=u.id WHERE COALESCE(p.xp,0)=0').n,
      byLevel:QA(`SELECT json_extract(data,'$.level') level,COUNT(*) n,COUNT(DISTINCT user_id) users FROM events WHERE type='lesson_pass' GROUP BY level ORDER BY level`),
      byType:QA('SELECT type,COUNT(*) n FROM events GROUP BY type ORDER BY n DESC'),
      daily:QA(`SELECT date(ts/1000,'unixepoch') day,COUNT(DISTINCT user_id) users,COUNT(*) events FROM events WHERE ts>? GROUP BY day ORDER BY day`,t-14*DAY)})}
    if(p==='/api/admin/users'&&m==='GET'){const q=u.searchParams.get('q')||'',f=u.searchParams.get('f')||'',s=u.searchParams.get('s')||'created',t=now(),w=[],a=[];
      if(q){w.push('(u.email LIKE ? OR u.name LIKE ?)');a.push(`%${q}%`,`%${q}%`)}
      if(f==='active7'){w.push('u.last_seen>?');a.push(t-7*DAY)}else if(f==='inactive'){w.push('(u.last_seen IS NULL OR u.last_seen<?)');a.push(t-14*DAY)}else if(f==='noprogress')w.push('COALESCE(p.xp,0)=0');else if(f==='blocked')w.push("u.status='blocked'");else if(f==='admins')w.push("u.role='admin'");
      const ord={created:'u.created_at DESC',seen:'u.last_seen DESC',xp:'xp DESC',name:'u.name COLLATE NOCASE'}[s]||'u.created_at DESC';
      return send(res,200,{rows:QA(`${LIST} ${w.length?'WHERE '+w.join(' AND '):''} ORDER BY ${ord} LIMIT 500`,...a)})}
    if(p==='/api/admin/events'&&m==='GET')return send(res,200,{rows:QA('SELECT e.id,e.type,e.data,e.ts,u.name,u.email,u.id uid FROM events e JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 150')});
    if(p==='/api/admin/export.csv'&&m==='GET'){const rows=QA(LIST+' ORDER BY u.id'),h=['id','email','name','role','status','created','last_login','last_seen','xp','lessons','words','streak'],iso=x=>x?new Date(x).toISOString():'';
      const out=[h.join(',')].concat(rows.map(r=>[r.id,r.email,r.name,r.role,r.status,iso(r.created_at),iso(r.last_login),iso(r.last_seen),r.xp,r.lessons,r.words,r.streak].map(csv).join(','))).join('\n');
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="users.csv"','Cache-Control':'no-store'});return res.end('\ufeff'+out)}
    const mu=p.match(/^\/api\/admin\/users\/(\d+)$/);
    if(mu){const id=+mu[1],t=Q(LIST+' WHERE u.id=?',id);if(!t)return send(res,404,{error:'not_found'});
      if(m==='GET'){const pr=Q('SELECT data FROM progress WHERE user_id=?',id);let done=[];try{done=Object.keys(JSON.parse(pr.data).done||{}).filter(k=>JSON.parse(pr.data).done[k])}catch{}
        return send(res,200,{user:t,done,events:QA('SELECT id,type,data,ts FROM events WHERE user_id=? ORDER BY id DESC LIMIT 200',id),counts:QA('SELECT type,COUNT(*) n FROM events WHERE user_id=? GROUP BY type',id)})}
      if(m==='POST'){const b=await body(req),a=b.action,self=id===me.id,admins=Q("SELECT COUNT(*) n FROM users WHERE role='admin'").n;let tmp;
        if(a==='block'){if(self)return send(res,400,{error:'self'});RUN("UPDATE users SET status='blocked' WHERE id=?",id);RUN('DELETE FROM sessions WHERE user_id=?',id)}
        else if(a==='unblock')RUN("UPDATE users SET status='active' WHERE id=?",id);
        else if(a==='promote')RUN("UPDATE users SET role='admin' WHERE id=?",id);
        else if(a==='demote'){if(self||admins<2)return send(res,400,{error:'last_admin'});RUN("UPDATE users SET role='user' WHERE id=?",id)}
        else if(a==='reset_password'){tmp=crypto.randomBytes(9).toString('base64url');const salt=crypto.randomBytes(16).toString('hex');RUN('UPDATE users SET salt=?,hash=? WHERE id=?',salt,hashPw(tmp,salt),id);RUN('DELETE FROM sessions WHERE user_id=?',id)}
        else if(a==='delete'){if(self)return send(res,400,{error:'self'});if(t.role==='admin'&&admins<2)return send(res,400,{error:'last_admin'});RUN('DELETE FROM users WHERE id=?',id)}
        else return send(res,400,{error:'bad_action'});
        return send(res,200,{ok:1,temp_password:tmp})}}
  }
  return send(res,404,{error:'not_found'});
}
const PUB=path.join(__dirname,'public'),MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'},PAGES={'/':'index.html','/app':'app.html','/admin':'admin.html'};
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x');
  if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end()}
  const rel=PAGES[u.pathname]||decodeURIComponent(u.pathname).replace(/^\/+/,''),f=path.join(PUB,rel);
  if(!f.startsWith(PUB+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found')}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':rel==='admin.html'||rel==='app.html'?'no-store':'public, max-age=300'});fs.createReadStream(f).pipe(res)
}catch(e){if(e&&e.code===413)return send(res,413,{error:'too_big'});if(e&&e.code===400)return send(res,400,{error:'bad_json'});console.error(e);if(!res.headersSent)send(res,500,{error:'server'})}}).listen(PORT,()=>console.log('English Ladder: http://localhost:'+PORT));
setInterval(()=>RUN('DELETE FROM sessions WHERE expires<?',now()),36e5).unref();
