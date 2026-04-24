require('dotenv').config();
const express=require('express');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const axios=require('axios');
const path=require('path');
const low=require('lowdb');
const FileSync=require('lowdb/adapters/FileSync');

const adapter=new FileSync('db.json');
const db=low(adapter);
db.defaults({users:[],transactions:[],orders:[]}).write();

const app=express();
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET=process.env.JWT_SECRET||'amazingsubz_secret';
const ADMIN_PASS=process.env.ADMIN_PASSWORD||'admin123';
const PS_KEY=process.env.PAYSTACK_SECRET_KEY||'';
const CDH_KEY=process.env.CDH_API_KEY||'';
const CDH='https://www.cheapdatahub.com.ng/api';

function genRef(x='T'){return x+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,7).toUpperCase();}
function genCode(){return Math.random().toString(36).slice(2,8).toUpperCase();}
function auth(req,res,next){
  const t=req.headers.authorization?.split(' ')[1];
  if(!t)return res.status(401).json({success:false,message:'Unauthorized'});
  try{req.user=jwt.verify(t,JWT_SECRET);next();}
  catch{res.status(401).json({success:false,message:'Invalid token'});}
}

app.post('/api/register',async(req,res)=>{
  try{
    const{name,email,phone,password,referral_code}=req.body;
    if(!name||!email||!password)return res.json({success:false,message:'Fill all fields'});
    if(db.get('users').find({email}).value())return res.json({success:false,message:'Email already registered'});
    const hash=await bcrypt.hash(password,10);
    const code=genCode();
    const id=Date.now();
    if(referral_code){
      const ref=db.get('users').find({referral_code}).value();
      if(ref){
        db.get('users').find({id:ref.id}).assign({wallet:(ref.wallet||0)+50}).write();
        db.get('transactions').push({id:Date.now(),user_id:ref.id,type:'referral',amount:50,desc:'Referral bonus',status:'success',ref:genRef('R'),created_at:new Date().toISOString()}).write();
      }
    }
    db.get('users').push({id,name,email,phone:phone||'',password:hash,wallet:0,referral_code:code,referred_by:referral_code||'',created_at:new Date().toISOString()}).write();
    const token=jwt.sign({id,email},JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user:{id,name,email,wallet:0,referral_code:code}});
  }catch(e){res.json({success:false,message:e.message});}
});

app.post('/api/login',async(req,res)=>{
  try{
    const{email,password}=req.body;
    const user=db.get('users').find({email}).value();
    if(!user||!await bcrypt.compare(password,user.password))return res.json({success:false,message:'Invalid email or password'});
    const token=jwt.sign({id:user.id,email},JWT_SECRET,{expiresIn:'30d'});
    res.json({success:true,token,user:{id:user.id,name:user.name,email:user.email,phone:user.phone,wallet:user.wallet,referral_code:user.referral_code}});
  }catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/me',auth,(req,res)=>{
  const user=db.get('users').find({id:req.user.id}).value();
  if(!user)return res.json({success:false});
  res.json({success:true,user:{id:user.id,name:user.name,email:user.email,phone:user.phone,wallet:user.wallet,referral_code:user.referral_code}});
});

app.post('/api/wallet/init',auth,async(req,res)=>{
  try{
    const{amount}=req.body;
    if(!amount||amount<100)return res.json({success:false,message:'Minimum deposit is N100'});
    const user=db.get('users').find({id:req.user.id}).value();
    const ref=genRef('DEP');
    const r=await axios.post('https://api.paystack.co/transaction/initialize',{email:user.email,amount:Math.round(amount*100),reference:ref,callback_url:`${process.env.BASE_URL||'http://localhost:3000'}?ref=${ref}`},{headers:{Authorization:`Bearer ${PS_KEY}`}});
    db.get('transactions').push({id:Date.now(),user_id:user.id,type:'deposit',amount,desc:'Wallet funding',status:'pending',ref,created_at:new Date().toISOString()}).write();
    res.json({success:true,url:r.data.data.authorization_url,ref});
  }catch(e){res.json({success:false,message:e.message});}
});

app.post('/api/wallet/verify',auth,async(req,res)=>{
  try{
    const{ref}=req.body;
    const r=await axios.get(`https://api.paystack.co/transaction/verify/${ref}`,{headers:{Authorization:`Bearer ${PS_KEY}`}});
    if(r.data.data.status!=='success')return res.json({success:false,message:'Payment not successful'});
    const txn=db.get('transactions').find({ref}).value();
    if(!txn)return res.json({success:false,message:'Transaction not found'});
    if(txn.status==='success')return res.json({success:true,message:'Already verified'});
    db.get('transactions').find({ref}).assign({status:'success'}).write();
    const user=db.get('users').find({id:txn.user_id}).value();
    db.get('users').find({id:txn.user_id}).assign({wallet:(user.wallet||0)+txn.amount}).write();
    const updated=db.get('users').find({id:txn.user_id}).value();
    res.json({success:true,message:`N${txn.amount} added to wallet`,wallet:updated.wallet});
  }catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/transactions',auth,(req,res)=>{
  const txns=db.get('transactions').filter({user_id:req.user.id}).sortBy('created_at').reverse().take(50).value();
  res.json({success:true,transactions:txns});
});

app.post('/api/buy/airtime',auth,async(req,res)=>{
  try{
    const{network,phone,amount}=req.body;
    if(!network||!phone||!amount||amount<50)return res.json({success:false,message:'Invalid request'});
    const user=db.get('users').find({id:req.user.id}).value();
    if((user.wallet||0)<amount)return res.json({success:false,message:'Insufficient wallet balance'});
    const newWallet=user.wallet-amount;
    db.get('users').find({id:user.id}).assign({wallet:newWallet}).write();
    const ref=genRef('AIR');
    try{
      const r=await axios.post(`${CDH}/topup/`,{api_key:CDH_KEY,network:network.toLowerCase(),mobile_number:phone,amount,Ported_number:true,airtime_type:'VTU'},{timeout:30000});
      if(r.data.Status!=='successful'){
        db.get('users').find({id:user.id}).assign({wallet:user.wallet}).write();
        return res.json({success:false,message:r.data.api_response||'Airtime purchase failed'});
      }
    }catch(e){
      db.get('users').find({id:user.id}).assign({wallet:user.wallet}).write();
      return res.json({success:false,message:'VTU service error. Try again.'});
    }
    db.get('orders').push({id:Date.now(),user_id:user.id,network,phone,type:'airtime',plan:`${network} Airtime`,amount,status:'success',ref,created_at:new Date().toISOString()}).write();
    db.get('transactions').push({id:Date.now()+1,user_id:user.id,type:'airtime',amount,desc:`${network} Airtime to ${phone}`,status:'success',ref,created_at:new Date().toISOString()}).write();
    const updated=db.get('users').find({id:user.id}).value();
    res.json({success:true,message:`N${amount} ${network} airtime sent to ${phone}!`,wallet:updated.wallet});
  }catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/data-plans/:network',auth,async(req,res)=>{
  try{
    const nm={mtn:1,glo:2,airtel:3,'9mobile':4};
    const r=await axios.get(`${CDH}/data-plans/`,{params:{api_key:CDH_KEY,network:nm[req.params.network.toLowerCase()]},timeout:10000});
    res.json({success:true,plans:r.data});
  }catch(e){res.json({success:false,plans:[]});}
});

app.post('/api/buy/data',auth,async(req,res)=>{
  try{
    const{network,phone,plan_id,plan_name,amount}=req.body;
    if(!network||!phone||!plan_id)return res.json({success:false,message:'Fill all fields'});
    const user=db.get('users').find({id:req.user.id}).value();
    if((user.wallet||0)<amount)return res.json({success:false,message:'Insufficient wallet balance'});
    const newWallet=user.wallet-amount;
    db.get('users').find({id:user.id}).assign({wallet:newWallet}).write();
    const ref=genRef('DAT');
    const nm={mtn:1,glo:2,airtel:3,'9mobile':4};
    try{
      const r=await axios.post(`${CDH}/data/`,{api_key:CDH_KEY,network:nm[network.toLowerCase()]||1,mobile_number:phone,plan:plan_id,Ported_number:true},{timeout:30000});
      if(r.data.Status!=='successful'){
        db.get('users').find({id:user.id}).assign({wallet:user.wallet}).write();
        return res.json({success:false,message:r.data.api_response||'Data purchase failed'});
      }
    }catch(e){
      db.get('users').find({id:user.id}).assign({wallet:user.wallet}).write();
      return res.json({success:false,message:'VTU service error. Try again.'});
    }
    db.get('orders').push({id:Date.now(),user_id:user.id,network,phone,type:'data',plan:plan_name,amount,status:'success',ref,created_at:new Date().toISOString()}).write();
    db.get('transactions').push({id:Date.now()+1,user_id:user.id,type:'data',amount,desc:`${network} ${plan_name} to ${phone}`,status:'success',ref,created_at:new Date().toISOString()}).write();
    const updated=db.get('users').find({id:user.id}).value();
    res.json({success:true,message:`${plan_name} sent to ${phone}!`,wallet:updated.wallet});
  }catch(e){res.json({success:false,message:e.message});}
});

app.get('/api/orders',auth,(req,res)=>{
  const orders=db.get('orders').filter({user_id:req.user.id}).sortBy('created_at').reverse().take(50).value();
  res.json({success:true,orders});
});

app.post('/api/admin/stats',(req,res)=>{
  if(req.body.key!==ADMIN_PASS)return res.json({success:false,message:'Wrong password'});
  const users=db.get('users').value();
  const orders=db.get('orders').value();
  const txns=db.get('transactions').value();
  const totalRevenue=txns.filter(t=>t.status==='success'&&t.type==='deposit').reduce((s,t)=>s+t.amount,0);
  const totalWallets=users.reduce((s,u)=>s+(u.wallet||0),0);
  const recentOrders=db.get('orders').sortBy('created_at').reverse().take(20).value().map(o=>{
    const u=users.find(u=>u.id===o.user_id);
    return{...o,name:u?.name,email:u?.email};
  });
  res.json({success:true,stats:{totalUsers:users.length,totalOrders:orders.length,totalRevenue,totalWallets,recentOrders}});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
app.listen(PORT,'0.0.0.0',()=>console.log(`Amazing Subz running on port ${PORT}`));

