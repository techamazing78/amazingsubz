require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_PATH = path.join(__dirname, 'amazingsubz.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, phone TEXT, password TEXT, wallet REAL DEFAULT 0, referral_code TEXT UNIQUE, referred_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, amount REAL, desc TEXT, status TEXT DEFAULT 'pending', ref TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, network TEXT, phone TEXT, type TEXT, plan TEXT, amount REAL, status TEXT DEFAULT 'pending', ref TEXT UNIQUE, api_ref TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  save();
  console.log('Database ready');
}

function save() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

function dbGet(sql, p=[]) { const s=db.prepare(sql); s.bind(p); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function dbAll(sql, p=[]) { const r=[],s=db.prepare(sql); s.bind(p); while(s.step()) r.push(s.getAsObject()); s.free(); return r; }
function dbRun(sql, p=[]) { db.run(sql,p); save(); return {lastInsertRowid: dbGet('SELECT last_insert_rowid() as id').id}; }
function genRef(x='T') { return x+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,7).toUpperCase(); }

const JWT_SECRET = process.env.JWT_SECRET||'amazingsubz_secret';
const ADMIN_PASS = process.env.ADMIN_PASSWORD||'admin123';
const PS_KEY = process.env.PAYSTACK_SECRET_KEY||'';
const CDH_KEY = process.env.CDH_API_KEY||'';
const CDH = 'https://www.cheapdatahub.com.ng/api';

function auth(req,res,next) {
  const t=req.headers.authorization?.split(' ')[1];
  if(!t) return res.status(401).json({success:false,message:'Unauthorized'});
  try { req.user=jwt.verify(t,JWT_SECRET); next(); }
  catch { res.status(401).json({success:false,message:'Invalid token'}); }
}

app.post('/api/register', async(req,res)=>{
  try {
    const {name,email,phone,password,referral_code}=req.body;
    if(!name||!email||!password) return res.json({success:false,message:'Fill all fields'});
    if(dbGet('SELECT id FROM users WHERE email=?',[email])) return res.json({success:false,message:'Email already registered'});
    const hash=await bcrypt.hash(password,10);
    const code=Math.random().toString(36).slice(2,8).toUpperCase();
    if(referral_code){const ref=dbGet('SELECT id FROM users WHERE referral_code=?',[referral_code]);if(ref){dbRun('UPDATE users SET wallet=wallet+50 WHERE id=?',[ref.id]);dbRun('INSERT INTO transactions(user_id,type,amount,desc,status,ref) VALUES(?,?,?,?,?,?)',[ref.id,'referral',50,'Referral bonus','success',genRef('R')]);}}
    const result=dbRun('INSERT INTO users(name,email,phone,password,referral_code,referred_by,wallet) VALUES(?,?,?,?,?,?,?)',[name,email,phone||'',hash,code,referral_code||'',0]);
    const token=jwt.sign({id:result.lastInsertRowid,email},JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user:{id:result.lastInsertRowid,name,email,wallet:0,referral_code:code}});
  } catch(e){res.json({success:false,message:e.message});}
});

app.post('/api/login', async(req,res)=>{
  try {
    const {email,password}=req.body;
    const user=dbGet('SELECT * FROM users WHERE email=?',[email]);
    if(!user||!await bcrypt.compare(password,user.password)) return res.json({success:false,message:'Invalid email or password'});
    const token=jwt.sign({id:user.id,email},JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user:{id:user.id,name:user.name,email:user.email,phone:user.phone,wallet:user.wallet,referral_code:user.referral_code}});
  } catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/me',auth,(req,res)=>{
  const user=dbGet('SELECT id,name,email,phone,wallet,referral_code FROM users WHERE id=?',[req.user.id]);
  res.json(user?{success:true,user}:{success:false});
});

app.post('/api/wallet/init',auth,async(req,res)=>{
  try {
    const {amount}=req.body;
    if(!amount||amount<100) return res.json({success:false,message:'Minimum deposit is N100'});
    const user=dbGet('SELECT * FROM users WHERE id=?',[req.user.id]);
    const ref=genRef('DEP');
    const r=await axios.post('https://api.paystack.co/transaction/initialize',{email:user.email,amount:Math.round(amount*100),reference:ref,callback_url:`${process.env.BASE_URL||'http://localhost:3000'}?ref=${ref}`},{headers:{Authorization:`Bearer ${PS_KEY}`}});
    dbRun('INSERT INTO transactions(user_id,type,amount,desc,status,ref) VALUES(?,?,?,?,?,?)',[user.id,'deposit',amount,'Wallet funding','pending',ref]);
    res.json({success:true,url:r.data.data.authorization_url,ref});
  } catch(e){res.json({success:false,message:e.message});}
});

app.post('/api/wallet/verify',auth,async(req,res)=>{
  try {
    const {ref}=req.body;
    const r=await axios.get(`https://api.paystack.co/transaction/verify/${ref}`,{headers:{Authorization:`Bearer ${PS_KEY}`}});
    if(r.data.data.status!=='success') return res.json({success:false,message:'Payment not successful'});
    const txn=dbGet('SELECT * FROM transactions WHERE ref=?',[ref]);
    if(!txn) return res.json({success:false,message:'Transaction not found'});
    if(txn.status==='success') return res.json({success:true,message:'Already verified'});
    dbRun('UPDATE transactions SET status=? WHERE ref=?',['success',ref]);
    dbRun('UPDATE users SET wallet=wallet+? WHERE id=?',[txn.amount,txn.user_id]);
    const user=dbGet('SELECT wallet FROM users WHERE id=?',[txn.user_id]);
    res.json({success:true,message:`N${txn.amount} added to wallet`,wallet:user.wallet});
  } catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/transactions',auth,(req,res)=>{
  res.json({success:true,transactions:dbAll('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50',[req.user.id])});
});

app.post('/api/buy/airtime',auth,async(req,res)=>{
  try {
    const {network,phone,amount}=req.body;
    if(!network||!phone||!amount||amount<50) return res.json({success:false,message:'Invalid request'});
    const user=dbGet('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(user.wallet<amount) return res.json({success:false,message:'Insufficient wallet balance'});
    dbRun('UPDATE users SET wallet=wallet-? WHERE id=?',[amount,user.id]);
    const ref=genRef('AIR');
    try {
      const r=await axios.post(`${CDH}/topup/`,{api_key:CDH_KEY,network:network.toLowerCase(),mobile_number:phone,amount,Ported_number:true,airtime_type:'VTU'},{timeout:30000});
      if(r.data.Status!=='successful'){dbRun('UPDATE users SET wallet=wallet+? WHERE id=?',[amount,user.id]);return res.json({success:false,message:r.data.api_response||'Failed'});}
    } catch(e){dbRun('UPDATE users SET wallet=wallet+? WHERE id=?',[amount,user.id]);return res.json({success:false,message:'VTU error, try again'});}
    dbRun('INSERT INTO orders(user_id,network,phone,type,plan,amount,status,ref) VALUES(?,?,?,?,?,?,?,?)',[user.id,network,phone,'airtime',`${network} Airtime`,amount,'success',ref]);
    dbRun('INSERT INTO transactions(user_id,type,amount,desc,status,ref) VALUES(?,?,?,?,?,?)',[user.id,'airtime',amount,`${network} Airtime to ${phone}`,'success',ref]);
    const updated=dbGet('SELECT wallet FROM users WHERE id=?',[user.id]);
    res.json({success:true,message:`N${amount} ${network} airtime sent to ${phone}!`,wallet:updated.wallet});
  } catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/data-plans/:network',auth,async(req,res)=>{
  try {
    const nm={mtn:1,glo:2,airtel:3,'9mobile':4};
    const r=await axios.get(`${CDH}/data-plans/`,{params:{api_key:CDH_KEY,network:nm[req.params.network.toLowerCase()]},timeout:10000});
    res.json({success:true,plans:r.data});
  } catch(e){res.json({success:false,plans:[]});}
});

app.post('/api/buy/data',auth,async(req,res)=>{
  try {
    const {network,phone,plan_id,plan_name,amount}=req.body;
    if(!network||!phone||!plan_id) return res.json({success:false,message:'Fill all fields'});
    const user=dbGet('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(user.wallet<amount) return res.json({success:false,message:'Insufficient wallet balance'});
    dbRun('UPDATE users SET wallet=wallet-? WHERE id=?',[amount,user.id]);
    const ref=genRef('DAT');
    const nm={mtn:1,glo:2,airtel:3,'9mobile':4};
    try {
      const r=await axios.post(`${CDH}/data/`,{api_key:CDH_KEY,network:nm[network.toLowerCase()]||1,mobile_number:phone,plan:plan_id,Ported_number:true},{timeout:30000});
      if(r.data.Status!=='successful'){dbRun('UPDATE users SET wallet=wallet+? WHERE id=?',[amount,user.id]);return res.json({success:false,message:r.data.api_response||'Failed'});}
    } catch(e){dbRun('UPDATE users SET wallet=wallet+? WHERE id=?',[amount,user.id]);return res.json({success:false,message:'VTU error, try again'});}
    dbRun('INSERT INTO orders(user_id,network,phone,type,plan,amount,status,ref) VALUES(?,?,?,?,?,?,?,?)',[user.id,network,phone,'data',plan_name,amount,'success',ref]);
    dbRun('INSERT INTO transactions(user_id,type,amount,desc,status,ref) VALUES(?,?,?,?,?,?)',[user.id,'data',amount,`${network} ${plan_name} to ${phone}`,'success',ref]);
    const updated=dbGet('SELECT wallet FROM users WHERE id=?',[user.id]);
    res.json({success:true,message:`${plan_name} sent to ${phone}!`,wallet:updated.wallet});
  } catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/orders',auth,(req,res)=>{
  res.json({success:true,orders:dbAll('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50',[req.user.id])});
});

app.post('/api/admin/stats',(req,res)=>{
  if(req.body.key!==ADMIN_PASS) return res.json({success:false,message:'Wrong password'});
  res.json({success:true,stats:{
    totalUsers:dbGet('SELECT COUNT(*) as c FROM users').c,
    totalOrders:dbGet('SELECT COUNT(*) as c FROM orders').c,
    totalRevenue:dbGet("SELECT SUM(amount) as s FROM transactions WHERE status='success' AND type='deposit'").s||0,
    totalWallets:dbGet('SELECT SUM(wallet) as s FROM users').s||0,
    recentOrders:dbAll('SELECT o.*,u.name,u.email FROM orders o LEFT JOIN users u ON o.user_id=u.id ORDER BY o.created_at DESC LIMIT 20')
  }});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
initDB().then(()=>app.listen(PORT,()=>console.log(`Amazing Subz running on port ${PORT}`)));
