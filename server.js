const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomInt, randomBytes } = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({limit:'32kb'}));
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
const rooms = new Map();

// --- Persistent accounts ---------------------------------------------------
// Set DATABASE_URL and JWT_SECRET in Render. The game still works as a guest
// without them, but signed-in career data requires the database.
const DATABASE_URL=process.env.DATABASE_URL||'';
const JWT_SECRET=process.env.JWT_SECRET||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false}}):null;
let dbReady=false;
async function initDb(){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sheepshead_users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name VARCHAR(18) NOT NULL DEFAULT 'Player',
    avatar VARCHAR(8) NOT NULL DEFAULT '🙂',
    career_score INTEGER NOT NULL DEFAULT 0,
    hands INTEGER NOT NULL DEFAULT 0,
    best_score INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  dbReady=true;
  console.log('Account database ready.');
}
initDb().catch(e=>console.error('Account database unavailable:',e.message));
function cleanUser(r){return{id:String(r.id),email:r.email,name:r.name,avatar:r.avatar,careerScore:r.career_score,hands:r.hands,bestScore:r.best_score}}
function signToken(id){return jwt.sign({sub:String(id)},JWT_SECRET,{expiresIn:'30d'})}
function tokenUserId(token){if(!JWT_SECRET||!token)return null;try{return jwt.verify(token,JWT_SECRET).sub||null}catch{return null}}
function bearer(req){return String(req.headers.authorization||'').replace(/^Bearer\s+/i,'')}
async function requireUser(req,res,next){
  if(!pool||!dbReady||!JWT_SECRET)return res.status(503).json({error:'Accounts are not configured yet.'});
  const id=tokenUserId(bearer(req));if(!id)return res.status(401).json({error:'Please sign in again.'});
  const q=await pool.query('SELECT * FROM sheepshead_users WHERE id=$1',[id]);if(!q.rows[0])return res.status(401).json({error:'Account not found.'});req.user=q.rows[0];next();
}
app.get('/api/auth/status',(req,res)=>res.json({configured:!!(pool&&JWT_SECRET),ready:dbReady}));
app.post('/api/auth/signup',async(req,res)=>{try{
  if(!pool||!dbReady||!JWT_SECRET)return res.status(503).json({error:'Accounts are not configured yet.'});
  const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||''),name=String(req.body.name||'Player').trim().slice(0,18)||'Player',avatar=String(req.body.avatar||'🙂').slice(0,8);
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:'Enter a valid email.'});
  if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
  const hash=await bcrypt.hash(password,12);
  const q=await pool.query('INSERT INTO sheepshead_users(email,password_hash,name,avatar) VALUES($1,$2,$3,$4) RETURNING *',[email,hash,name,avatar]);
  res.json({token:signToken(q.rows[0].id),user:cleanUser(q.rows[0])});
}catch(e){if(e.code==='23505')return res.status(409).json({error:'An account with that email already exists.'});console.error(e);res.status(500).json({error:'Could not create account.'})}});
app.post('/api/auth/login',async(req,res)=>{try{
  if(!pool||!dbReady||!JWT_SECRET)return res.status(503).json({error:'Accounts are not configured yet.'});
  const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
  const q=await pool.query('SELECT * FROM sheepshead_users WHERE email=$1',[email]);const u=q.rows[0];
  if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Email or password is incorrect.'});
  res.json({token:signToken(u.id),user:cleanUser(u)});
}catch(e){console.error(e);res.status(500).json({error:'Could not sign in.'})}});
app.get('/api/me',requireUser,(req,res)=>res.json({user:cleanUser(req.user)}));
app.patch('/api/me',requireUser,async(req,res)=>{try{const name=String(req.body.name||req.user.name).trim().slice(0,18)||'Player',avatar=String(req.body.avatar||req.user.avatar).slice(0,8);const q=await pool.query('UPDATE sheepshead_users SET name=$1,avatar=$2 WHERE id=$3 RETURNING *',[name,avatar,req.user.id]);res.json({user:cleanUser(q.rows[0])})}catch(e){res.status(500).json({error:'Could not update profile.'})}});
app.post('/api/me/reset',requireUser,async(req,res)=>{try{const q=await pool.query('UPDATE sheepshead_users SET career_score=0,hands=0,best_score=0 WHERE id=$1 RETURNING *',[req.user.id]);res.json({user:cleanUser(q.rows[0])})}catch(e){res.status(500).json({error:'Could not reset career.'})}});
async function recordCareer(room,delta){
  if(room.mode!=='single'||!pool||!dbReady)return;
  const p=room.players.find(x=>!x.isBot&&x.accountId);if(!p)return;
  try{await pool.query('UPDATE sheepshead_users SET career_score=career_score+$1,hands=hands+1,best_score=GREATEST(best_score,career_score+$1) WHERE id=$2',[Number(delta)||0,p.accountId]);}
  catch(e){console.error('Career save failed:',e.message)}
}


const SUITS=['C','S','H','D'];
const RANKS=['7','8','9','K','10','A','J','Q'];
const POINTS={A:11,'10':10,K:4,Q:3,J:2,'9':0,'8':0,'7':0};
const TRUMP_ORDER=['QC','QS','QH','QD','JC','JS','JH','JD','AD','10D','KD','9D','8D','7D'];
const NONTRUMP_ORDER=['A','10','K','9','8','7'];
const deck=()=>SUITS.flatMap(s=>RANKS.map(r=>({r,s,id:r+s})));
const isTrump=c=>c.s==='D'||c.r==='Q'||c.r==='J';
const leadClass=c=>isTrump(c)?'T':c.s;
const suitName=s=>({C:'Clubs',S:'Spades',H:'Hearts',D:'Diamonds'}[s]||s);

function shuffle(a){
  // Three independent cryptographic Fisher-Yates passes plus a secure cut.
  // One Fisher-Yates pass is already mathematically uniform; the extra passes
  // do not bias the deck and make each deal depend on fresh OS entropy several
  // times instead of on a pseudo-random Math.random() sequence.
  let out=[...a];
  for(let pass=0;pass<3;pass++){
    for(let i=out.length-1;i>0;i--){
      const j=randomInt(i+1);
      [out[i],out[j]]=[out[j],out[i]];
    }
  }
  const cut=randomInt(out.length);
  out=out.slice(cut).concat(out.slice(0,cut));
  return out;
}
function cardBeats(a,b,lead){const at=isTrump(a),bt=isTrump(b);if(at&&bt)return TRUMP_ORDER.indexOf(a.id)<TRUMP_ORDER.indexOf(b.id);if(at&&!bt)return true;if(!at&&bt)return false;if(a.s!==b.s)return a.s===lead;return NONTRUMP_ORDER.indexOf(a.r)<NONTRUMP_ORDER.indexOf(b.r)}
function legalCards(hand,trick){if(!trick.length)return hand;const lead=leadClass(trick[0].card);const follows=hand.filter(c=>lead==='T'?isTrump(c):(!isTrump(c)&&c.s===lead));return follows.length?follows:hand}

// Called-ace house rule: the partner must hold the called ace until the called
// suit is led. The partner may lead that ace only when the called suit is their
// only fail (non-trump) suit. If the called suit is led by anyone else, the ace
// is mandatory, even if the partner has another card of that suit.
function legalCardsFor(room,seat){
  const g=room.game,p=room.players[seat];
  if(!g||!p)return[];
  let legal=legalCards(p.hand,g.trick);
  if(room.phase!=='playing'||g.partner==null||seat!==g.partner||g.partnerRevealed||!g.calledSuit)return legal;

  const ace=p.hand.find(c=>c.r==='A'&&c.s===g.calledSuit&&!isTrump(c));
  if(!ace)return legal;

  // Partner is leading. They cannot lead the called suit while another fail
  // suit remains. If the called suit is their only fail suit, only the ace
  // itself (not a lower card of that suit) may be used to lead that suit.
  if(!g.trick.length){
    const hasOtherFail=p.hand.some(c=>!isTrump(c)&&c.s!==g.calledSuit);
    if(hasOtherFail){
      const filtered=legal.filter(c=>isTrump(c)||c.s!==g.calledSuit);
      return filtered.length?filtered:legal;
    }
    const filtered=legal.filter(c=>isTrump(c)||c.id===ace.id);
    return filtered.length?filtered:legal;
  }

  const lead=leadClass(g.trick[0].card);
  if(lead===g.calledSuit)return[ace];

  // The ace cannot be sloughed on another suit/trump while another legal card
  // exists. If it is literally the final/only available card, allow it so the
  // game can always complete.
  if(legal.some(c=>c.id===ace.id)&&legal.length>1){
    const filtered=legal.filter(c=>c.id!==ace.id);
    if(filtered.length)return filtered;
  }
  return legal;
}
function strength(c){return isTrump(c)?200-TRUMP_ORDER.indexOf(c.id)*5:100-NONTRUMP_ORDER.indexOf(c.r)*5}
function handPower(hand){const tr=hand.filter(isTrump);return tr.length*3.2+tr.reduce((n,c)=>n+(14-TRUMP_ORDER.indexOf(c.id))*.42,0)+hand.reduce((n,c)=>n+POINTS[c.r]*.13,0)}
function createPlayer(name,socketId=null,isBot=false,avatar='🙂',accountId=null){return{id:socketId||`bot-${randomBytes(6).toString('hex')}`,name,isBot,avatar,accountId,hand:[],tricks:[],gameScore:0,connected:true}}
function roomCode(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let c;do{c='';for(let i=0;i<5;i++)c+=chars[randomInt(chars.length)]}while(rooms.has(c));return c}
function sortHands(room){const sn={C:0,S:1,H:2,D:3};for(const p of room.players)p.hand.sort((a,b)=>{if(isTrump(a)!==isTrump(b))return isTrump(a)?-1:1;if(isTrump(a))return TRUMP_ORDER.indexOf(a.id)-TRUMP_ORDER.indexOf(b.id);if(a.s!==b.s)return sn[a.s]-sn[b.s];return NONTRUMP_ORDER.indexOf(a.r)-NONTRUMP_ORDER.indexOf(b.r)})}
function clampSettings(raw={}){return{allPassMode:raw.allPassMode==='doubler'?'doubler':'leaster',cracking:raw.cracking!==false,blitzers:raw.blitzers!==false,payoutUnit:[0,.25,.5,1].includes(Number(raw.payoutUnit))?Number(raw.payoutUnit):0,password:String(raw.password||'').slice(0,24)}}
function payoutLabel(room,points){if(!room.settings.payoutUnit)return `${points>0?'+':''}${points}`;const cash=points*room.settings.payoutUnit;return `${points>0?'+':''}${points} (${cash>=0?'+':''}$${cash.toFixed(2)})`}
function trickWinner(trick){if(!trick.length)return null;const lead=leadClass(trick[0].card);let win=trick[0];for(const x of trick.slice(1))if(cardBeats(x.card,win.card,lead==='T'?null:lead))win=x;return win}
function canBlitzHand(hand,type){const ids=new Set(hand.map(c=>c.id));return type==='BLACK'?ids.has('QC')&&ids.has('QS'):ids.has('QH')&&ids.has('QD')}
function eligibleCrackers(room){const g=room.game;if(!g||g.picker==null)return[];return room.players.map((p,i)=>i).filter(i=>i!==g.picker&&i!==g.partner&&!g.passed.includes(i))}
function humanIds(room){return room.players.filter(p=>!p.isBot&&p.connected).map(p=>p.id)}
function readyInfo(room,viewerId){const ids=humanIds(room);const set=room.readySet||new Set();return{needed:ids.length,ready:ids.filter(id=>set.has(id)).length,youReady:set.has(viewerId),names:ids.filter(id=>set.has(id)).map(id=>room.players.find(p=>p.id===id)?.name).filter(Boolean)}}
function resetReady(room){room.readySet=new Set()}
function allHumansReady(room){const ids=humanIds(room);return ids.length>0&&ids.every(id=>room.readySet?.has(id))}

function publicState(room,viewerId){
  const g=room.game, viewer=room.players.find(p=>p.id===viewerId), viewerSeat=room.players.findIndex(p=>p.id===viewerId);
  const callable=g&&g.picker!=null?['C','S','H'].filter(s=>{const h=room.players[g.picker].hand;return !h.some(c=>c.r==='A'&&c.s===s)&&h.some(c=>!isTrump(c)&&c.s===s)}):[];
  const canCrack=!!(g&&room.phase==='doubling'&&room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(viewerSeat));
  const canRecrack=!!(g&&room.phase==='doubling'&&room.settings.cracking&&g.crackCount===1&&(viewerSeat===g.picker||viewerSeat===g.partner));
  const blitzOptions=[];
  if(g&&room.phase==='doubling'&&room.settings.blitzers&&viewer){for(const t of ['BLACK','RED'])if(canBlitzHand(viewer.hand,t)&&!g.blitzedBy.some(x=>x.seat===viewerSeat&&x.type===t))blitzOptions.push(t)}
  const readyPhases=['lobby','doubling','trickEnd','roundEnd'];
  return{
    code:room.code,hostId:room.hostId,mode:room.mode||'multiplayer',phase:room.phase,settings:{...room.settings,password:room.settings.password?'••••':''},
    players:room.players.map((p,i)=>({id:p.id,name:p.name,avatar:p.avatar,isBot:p.isBot,connected:p.connected,seat:i,cards:p.hand.length,tricks:p.tricks.length/5,gameScore:p.gameScore,payout:payoutLabel(room,p.gameScore)})),
    you:viewerId,dealer:g?.dealer??room.pendingDeal?.dealer??0,current:g?.current??null,picker:g?.picker??null,calledSuit:g?.calledSuit??null,
    partner:g?.partnerRevealed?(g?.partner??null):null,partnerRevealed:g?.partnerRevealed??false,alone:g?.alone??false,trick:g?.trick??[],trickNo:g?.trickNo??0,
    trickWinner:g?.lastTrickWinner??null,teamPoints:g?.teamPoints??null,message:room.message||'',hand:viewer?.hand||[],
    legal:g&&['playing','leaster'].includes(room.phase)&&room.players[g.current]?.id===viewerId?legalCardsFor(room,g.current).map(c=>c.id):[],
    canPick:g&&room.phase==='picking'&&room.players[g.current]?.id===viewerId,canDiscard:g&&room.phase==='discard'&&room.players[g.picker]?.id===viewerId,
    canCall:g&&room.phase==='call'&&room.players[g.picker]?.id===viewerId,callableSuits:callable,canCrack,canRecrack,blitzOptions,multiplier:g?.multiplier??room.pendingDeal?.multiplier??1,
    announcementLines:(g?.announcements||[]),introVisible:!!(g&&g.announcements?.length&&['discard','call','doubling','playing'].includes(room.phase)&&g.trickNo===0&&g.trick.length===0),
    history:room.history.slice(-12).reverse(),roundNumber:room.roundNumber||0,leaster:room.phase==='leaster',ready:readyPhases.includes(room.phase)?readyInfo(room,viewerId):null,
    shuffling:room.phase==='shuffling',collecting:room.phase==='collecting'
  }
}
function emit(room){for(const p of room.players.filter(p=>!p.isBot&&p.connected))io.to(p.id).emit('state',publicState(room,p.id))}
function fillBots(room){const bots=[['Otto','🧔'],['Mabel','👩‍🦳'],['Fritz','🧢'],['Greta','👩'],['Walter','👨‍🦰']];while(room.players.length<5){const [n,a]=bots[room.players.length];room.players.push(createPlayer(n,null,true,a))}}

function beginShuffle(room,mode='normal',carryMultiplier=1){
  fillBots(room);
  const prevDealer=room.game?.dealer??-1;
  const dealer=(prevDealer+1)%5;
  room.pendingDeal={mode,carryMultiplier,dealer,multiplier:carryMultiplier};
  for(const p of room.players){p.hand=[];p.tricks=[]}
  room.game={dealer,current:null,picker:null,blind:[],discard:[],calledSuit:null,partner:null,partnerRevealed:false,alone:false,trick:[],trickNo:0,passed:[],teamPoints:null,multiplier:carryMultiplier,crackCount:0,blitzedBy:[],announcements:[],mode,lastTrickWinner:null,playHistory:[]};
  room.phase='shuffling';
  room.message=`${room.players[dealer].name} is shuffling…`;
  resetReady(room);emit(room);
  setTimeout(()=>{if(room.phase==='shuffling'&&room.pendingDeal?.dealer===dealer)dealRound(room,mode,carryMultiplier,dealer)},3100);
}
function dealRound(room,mode='normal',carryMultiplier=1,dealerOverride=null){
  fillBots(room);const dealer=dealerOverride??((room.game?.dealer??-1)+1)%5;const d=shuffle(deck());for(const p of room.players){p.hand=[];p.tricks=[]}let idx=0,blind=[];
  for(let pass=0;pass<2;pass++){for(let i=1;i<=5;i++){const seat=(dealer+i)%5;room.players[seat].hand.push(...d.slice(idx,idx+3));idx+=3;if(pass===0&&i===2){blind=d.slice(idx,idx+2);idx+=2}}}
  room.pendingDeal=null;room.roundNumber=(room.roundNumber||0)+1;
  room.game={dealer,current:(dealer+1)%5,picker:null,blind,discard:[],calledSuit:null,partner:null,partnerRevealed:false,alone:false,trick:[],trickNo:0,passed:[],teamPoints:null,multiplier:carryMultiplier,crackCount:0,blitzedBy:[],announcements:[],mode,lastTrickWinner:null,playHistory:[]};sortHands(room);
  if(mode==='leaster'){room.phase='leaster';room.message='Leaster: lowest card-point total with at least one trick wins.';emit(room);scheduleBots(room)}
  else{room.phase='picking';room.message=`${room.players[room.game.current].name} decides first.`;emit(room);scheduleBots(room)}
}
function startRound(room){const mult=room.nextMultiplier||1;room.nextMultiplier=1;beginShuffle(room,'normal',mult)}
function actPick(room,seat,pick){const g=room.game;if(room.phase!=='picking'||g.current!==seat)return;if(pick){g.picker=seat;room.players[seat].hand.push(...g.blind);g.blind=[];sortHands(room);room.phase='discard';g.announcements=[`${room.players[seat].name.toUpperCase()} PICKED`];room.message=`${room.players[seat].name} picked. Discard two cards.`;}else{g.passed.push(seat);if(g.passed.length===5){if(room.settings.allPassMode==='leaster'){room.message='Everyone passed — leaster coming up.';emit(room);return setTimeout(()=>beginShuffle(room,'leaster',g.multiplier),700)}room.nextMultiplier=Math.min(16,(room.nextMultiplier||1)*2);room.message=`Everyone passed — next hand is a x${room.nextMultiplier} doubler.`;emit(room);return setTimeout(()=>startRound(room),900)}g.current=(g.current+1)%5;room.message=`${room.players[seat].name} passed. ${room.players[g.current].name} decides.`}emit(room);scheduleBots(room)}
function discard(room,seat,ids){const g=room.game;if(room.phase!=='discard'||g.picker!==seat||!Array.isArray(ids)||ids.length!==2)return;const p=room.players[seat];const cards=ids.map(id=>p.hand.find(c=>c.id===id));if(cards.some(c=>!c))return;p.hand=p.hand.filter(c=>!ids.includes(c.id));g.discard=cards;room.phase='call';room.message=`${p.name}: call a partner ace, or go alone.`;emit(room);scheduleBots(room)}
function callPartner(room,seat,suit){const g=room.game;if(room.phase!=='call'||g.picker!==seat)return;if(suit==='ALONE'){g.alone=true;g.partner=null;g.partnerRevealed=false;g.calledSuit=null}else{const h=room.players[seat].hand;const valid=['C','S','H'].includes(suit)&&!h.some(c=>c.r==='A'&&c.s===suit)&&h.some(c=>!isTrump(c)&&c.s===suit);if(!valid)return;g.calledSuit=suit;g.partnerRevealed=false;g.partner=room.players.findIndex((p,i)=>i!==seat&&p.hand.some(c=>c.r==='A'&&c.s===suit));if(g.partner<0){g.alone=true;g.partner=null}}room.phase='doubling';g.current=(g.dealer+1)%5;g.trick=[];g.announcements.push(g.alone?'GOING ALONE':`CALLED ACE OF ${suitName(suit).toUpperCase()}`);room.message=g.alone?`${room.players[seat].name} is going alone. Everyone press Start Play when ready.`:`${room.players[seat].name} called the Ace of ${suitName(suit)}. Everyone press Start Play when ready.`;resetReady(room);emit(room);scheduleBots(room)}
function applyDouble(room,seat,type){const g=room.game;if(room.phase!=='doubling')return;
  if(type==='CRACK'&&room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(seat)){g.crackCount=1;g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} cracked! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} CRACKED — ×${g.multiplier}`)}
  else if(type==='RECRACK'&&room.settings.cracking&&g.crackCount===1&&(seat===g.picker||seat===g.partner)){g.crackCount=2;g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} re-cracked! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} RE-CRACKED — ×${g.multiplier}`)}
  else if((type==='BLACK'||type==='RED')&&room.settings.blitzers&&canBlitzHand(room.players[seat].hand,type)&&!g.blitzedBy.some(x=>x.seat===seat&&x.type===type)){g.blitzedBy.push({seat,type});g.multiplier=Math.min(16,g.multiplier*2);room.message=`${room.players[seat].name} called ${type==='BLACK'?'black':'red'} blitzers! x${g.multiplier}`;g.announcements.push(`${room.players[seat].name.toUpperCase()} — ${type} QUEENS BLITZ ×${g.multiplier}`)}
  else return;emit(room);scheduleBots(room)}
function beginPlay(room){const g=room.game;if(room.phase!=='doubling')return;room.phase='playing';g.current=(g.dealer+1)%5;g.announcements.push(`PLAY BEGINS${g.multiplier>1?` — ×${g.multiplier}`:''}`,`${room.players[g.current].name.toUpperCase()} LEADS`);room.message=`Play begins${g.multiplier>1?` at x${g.multiplier}`:''}. ${room.players[g.current].name} leads.`;resetReady(room);emit(room);scheduleBots(room)}
function playCard(room,seat,id){const g=room.game;if(!['playing','leaster'].includes(room.phase)||g.current!==seat)return;const p=room.players[seat];const card=p.hand.find(c=>c.id===id);if(!card||!legalCardsFor(room,seat).some(c=>c.id===id))return;p.hand=p.hand.filter(c=>c.id!==id);if(room.phase==='playing'&&g.partner!=null&&!g.partnerRevealed&&seat===g.partner&&g.calledSuit&&card.r==='A'&&card.s===g.calledSuit){g.partnerRevealed=true;room.message=`${p.name} is the partner!`}g.playHistory??=[];g.playHistory.push({trickNo:g.trickNo,seat,card:{...card}});g.trick.push({seat,card});if(g.trick.length<5){g.current=(g.current+1)%5;room.message=`${room.players[g.current].name}'s turn.`;emit(room);scheduleBots(room);return}const win=trickWinner(g.trick);room.players[win.seat].tricks.push(...g.trick.map(x=>x.card));g.current=win.seat;g.lastTrickWinner=win.seat;g.trickNo++;room.phase='trickEnd';room.message=`${room.players[win.seat].name} took trick ${g.trickNo}. Everyone press Next Trick.`;resetReady(room);emit(room)}
function advanceAfterTrick(room){const g=room.game;if(room.phase!=='trickEnd')return;resetReady(room);room.phase='collecting';room.message=`${room.players[g.lastTrickWinner].name} gathers the trick.`;emit(room);setTimeout(()=>{if(room.phase!=='collecting')return;if(g.trickNo===6){g.trick=[];return g.mode==='leaster'?scoreLeaster(room):scoreRound(room)}g.trick=[];g.lastTrickWinner=null;room.phase=g.mode==='leaster'?'leaster':'playing';room.message=`${room.players[g.current].name} leads trick ${g.trickNo+1}.`;emit(room);scheduleBots(room)},1150)}
function baseScore(pp,op,pickerTricks,oppTricks){const won=pp>=61;if(won){if(oppTricks===0)return 3;if(op<=30)return 2;return 1}else{if(pickerTricks===0)return 3;if(pp<=30)return 2;return 1}}
function scoreRound(room){const g=room.game;const pickerTeam=[g.picker,...(g.partner!=null?[g.partner]:[])];let pp=g.discard.reduce((s,c)=>s+POINTS[c.r],0),op=0,pt=0,ot=0;room.players.forEach((p,i)=>{const pts=p.tricks.reduce((s,c)=>s+POINTS[c.r],0);if(pickerTeam.includes(i)){pp+=pts;pt+=p.tricks.length/5}else{op+=pts;ot+=p.tricks.length/5}});g.teamPoints={picker:pp,opponents:op};const won=pp>=61,b=baseScore(pp,op,pt,ot)*g.multiplier;const delta=Array(5).fill(0);if(g.partner==null){delta[g.picker]=(won?4:-4)*b;room.players.forEach((p,i)=>{if(i!==g.picker)delta[i]=(won?-1:1)*b})}else{delta[g.picker]=(won?2:-2)*b;delta[g.partner]=(won?1:-1)*b;room.players.forEach((p,i)=>{if(!pickerTeam.includes(i))delta[i]=(won?-1:1)*b})}room.players.forEach((p,i)=>p.gameScore+=delta[i]);room.phase='roundEnd';const label=`Picker team ${won?'wins':'loses'} ${pp}–${op}${g.multiplier>1?` (x${g.multiplier})`:''}.`;room.message=`${label} Everyone press Next Round.`;room.history.push({round:room.roundNumber,type:'Normal',summary:label,delta:room.players.map((p,i)=>({name:p.name,change:delta[i]}))});const human=room.players.findIndex(p=>!p.isBot&&p.accountId);if(human>=0)recordCareer(room,delta[human]);resetReady(room);emit(room)}
function scoreLeaster(room){const g=room.game;const lastWinner=g.current;if(g.blind.length)room.players[lastWinner].tricks.push(...g.blind);const totals=room.players.map(p=>p.tricks.reduce((s,c)=>s+POINTS[c.r],0));const eligible=room.players.map((p,i)=>({i,pts:totals[i],tricks:p.tricks.length/5})).filter(x=>x.tricks>0);const min=Math.min(...eligible.map(x=>x.pts));const winners=eligible.filter(x=>x.pts===min);const delta=Array(5).fill(0);let summary;if(winners.length===1){const w=winners[0].i,m=g.multiplier;delta[w]=4*m;room.players.forEach((p,i)=>{if(i!==w)delta[i]=-1*m});summary=`Leaster: ${room.players[w].name} wins with ${min} points.`}else summary=`Leaster tie at ${min} points — no score.`;room.players.forEach((p,i)=>p.gameScore+=delta[i]);room.phase='roundEnd';room.message=`${summary} Everyone press Next Round.`;room.history.push({round:room.roundNumber,type:'Leaster',summary,delta:room.players.map((p,i)=>({name:p.name,change:delta[i]}))});const human=room.players.findIndex(p=>!p.isBot&&p.accountId);if(human>=0)recordCareer(room,delta[human]);resetReady(room);emit(room)}
function botPickScore(hand){
  const tr=hand.filter(isTrump), top=new Set(['QC','QS','QH','QD','JC','JS']);
  const offAces=hand.filter(c=>!isTrump(c)&&c.r==='A').length;
  const offTens=hand.filter(c=>!isTrump(c)&&c.r==='10').length;
  const topTrump=tr.filter(c=>top.has(c.id)).length;
  const suitCounts=['C','S','H'].map(s=>hand.filter(c=>!isTrump(c)&&c.s===s).length);
  const voids=suitCounts.filter(n=>n===0).length;
  const shortSuits=suitCounts.filter(n=>n===1).length;
  const highTrump=tr.reduce((n,c)=>n+Math.max(0,11-TRUMP_ORDER.indexOf(c.id))*.34,0);
  return tr.length*4.45+topTrump*2.45+highTrump+offAces*2.65+offTens*.8+voids*.95+shortSuits*.3+hand.reduce((n,c)=>n+POINTS[c.r]*.075,0);
}
function botShouldPick(room,seat){
  const g=room.game, hand=room.players[seat].hand, score=botPickScore(hand);
  const trumps=hand.filter(isTrump).length, queens=hand.filter(c=>c.r==='Q').length;
  const top3=hand.filter(c=>['QC','QS','QH'].includes(c.id)).length;
  // Position matters: later seats can responsibly loosen because fewer players
  // remain who can pick. Strong top-trump structures are valued more than raw points.
  const late=Math.min(2.6,g.passed.length*.65);
  const threshold=19.6-late;
  return score>=threshold || (trumps>=4&&score>=16.8) || (queens>=2&&trumps>=3) || (top3>=1&&trumps>=5);
}
function planScore(keep){
  const tr=keep.filter(isTrump), off=keep.filter(c=>!isTrump(c));
  let score=botPickScore(keep)*1.1;
  for(const suit of ['C','S','H']){
    const cards=off.filter(c=>c.s===suit);
    if(cards.length===0)score+=3.8; // useful void for trumping later
    if(cards.length===1&&cards[0].r==='A')score+=3.4;
    if(cards.length===1&&cards[0].r==='10')score-=1.0;
    if(cards.length>=3)score-=.8*(cards.length-2);
  }
  if(tr.length>=5)score+=2.2;
  return score;
}
function botDiscard(hand){
  // Exhaustively examine every legal two-card bury (28 possibilities from 8).
  // Score both the points safely buried and the quality/shape of the six-card hand left.
  if(!Array.isArray(hand)||hand.length<2)return [];
  let best=null;
  for(let i=0;i<hand.length-1;i++)for(let j=i+1;j<hand.length;j++){
    const pair=[hand[i],hand[j]], keep=hand.filter((_,k)=>k!==i&&k!==j);
    let score=planScore(keep);
    score+=pair.reduce((n,c)=>n+(POINTS[c.r]||0)*1.65,0);
    for(const c of pair){
      if(isTrump(c)){
        const ti=TRUMP_ORDER.indexOf(c.id);
        score-=9.5+Math.max(0,13-(ti<0?13:ti))*1.15;
      }
      if(!isTrump(c)&&c.r==='A')score-=17;
      if(!isTrump(c)&&c.r==='10')score+=2.4;
      if(!isTrump(c)&&c.r==='K')score+=1.0;
    }
    const callable=['C','S','H'].filter(s=>!keep.some(c=>c.r==='A'&&c.s===s)&&keep.some(c=>!isTrump(c)&&c.s===s));
    const aloneQuality=botPickScore(keep)>=30&&keep.filter(isTrump).length>=5;
    if(!callable.length&&!aloneQuality)score-=25;
    if(!best||score>best.score)best={score,ids:[pair[0].id,pair[1].id]};
  }
  return best?.ids||hand.slice(0,2).map(c=>c.id);
}

function runBotDiscard(room,seat){
  if(!room?.game||room.phase!=='discard'||room.game.picker!==seat)return false;
  const p=room.players[seat];
  if(!p?.isBot||!Array.isArray(p.hand)||p.hand.length<2)return false;
  const chooseValidIds=()=>{
    const currentIds=new Set(p.hand.map(c=>c.id));
    let ids=[];
    try{ids=botDiscard(p.hand)}catch(err){console.error('Smart bot discard failed:',err)}
    const valid=x=>Array.isArray(x)&&x.length===2&&x[0]!==x[1]&&x.every(id=>currentIds.has(id));
    if(!valid(ids)){try{ids=fallbackBotDiscard(p.hand)}catch(err){console.error('Fallback bot discard failed:',err)}}
    if(!valid(ids))ids=p.hand.slice(0,2).map(c=>c.id);
    return valid(ids)?ids:null;
  };
  const ids=chooseValidIds();if(!ids)return false;
  const cards=ids.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean);if(cards.length!==2)return false;
  const bury=new Set(ids);p.hand=p.hand.filter(c=>!bury.has(c.id));
  if(p.hand.length!==6){p.hand.push(...cards);sortHands(room);return false}
  room.game.discard=cards;room.phase='call';room.message=`${p.name} buried two cards and is choosing a partner.`;
  console.log(`[BOT] ${p.name} discarded ${ids.join(', ')}; 6 cards remain.`);emit(room);scheduleBots(room);return true;
}

function botCallChoice(hand){
  const trumps=hand.filter(isTrump).length;
  const topTrump=hand.filter(c=>['QC','QS','QH','QD','JC','JS'].includes(c.id)).length;
  // Alone should be genuinely strong; a partner is worth a lot in five-player play.
  if(trumps>=6&&topTrump>=3&&botPickScore(hand)>=32)return 'ALONE';
  if(trumps>=5&&topTrump>=4&&botPickScore(hand)>=34)return 'ALONE';
  const choices=['C','S','H'].filter(s=>!hand.some(c=>c.r==='A'&&c.s===s)&&hand.some(c=>!isTrump(c)&&c.s===s));
  if(!choices.length)return 'ALONE';
  const rankValue={7:0,8:.5,9:1,K:2.5,'10':5.5,A:10};
  // Prefer a short called suit with a low card to lead into the partner's ace.
  // A ten in that suit can be useful to smear behind the forced ace, so it is not fatal.
  choices.sort((a,b)=>{
    const evalSuit=s=>{
      const cards=hand.filter(c=>!isTrump(c)&&c.s===s);
      const low=Math.min(...cards.map(c=>rankValue[c.r]??3));
      const ten=cards.some(c=>c.r==='10')?1.2:0;
      return cards.length*4.2+low-ten;
    };
    return evalSuit(a)-evalSuit(b);
  });
  return choices[0];
}
function trickPoints(trick){return trick.reduce((n,x)=>n+POINTS[x.card.r],0)}
function lowToHigh(cards){return [...cards].sort((a,b)=>strength(a)-strength(b))}
function cheapWinner(cards,current,lead){return lowToHigh(cards.filter(c=>cardBeats(c,current.card,lead)))[0]||null}
function knownSameTeam(g,seat,other){
  if(seat===other)return true;
  if(g.mode==='leaster')return false;
  if(seat===g.picker)return g.partnerRevealed&&other===g.partner;
  if(seat===g.partner)return other===g.picker; // partner knows they hold the called ace
  if(other===g.picker)return false;
  if(g.partnerRevealed&&other===g.partner)return false;
  return g.partnerRevealed&&seat!==g.partner&&other!==g.partner;
}
function publicKnownIds(room,seat){
  const g=room.game, ids=new Set(room.players[seat].hand.map(c=>c.id));
  for(const x of g.playHistory||[])ids.add(x.card.id);
  for(const x of g.trick||[])ids.add(x.card.id);
  // Only the picker knows what they buried. Do not let defenders cheat.
  if(seat===g.picker)for(const c of g.discard||[])ids.add(c.id);
  return ids;
}
function unseenCards(room,seat){const known=publicKnownIds(room,seat);return deck().filter(c=>!known.has(c.id))}
function inferredVoid(room,other,cls){
  // A player who failed to follow a class on a prior trick is publicly known void in it.
  const hist=room.game.playHistory||[];
  const grouped=new Map();
  for(const x of hist){if(!grouped.has(x.trickNo))grouped.set(x.trickNo,[]);grouped.get(x.trickNo).push(x)}
  for(const plays of grouped.values()){
    if(plays.length<2)continue;
    const lead=leadClass(plays[0].card);
    if(lead!==cls)continue;
    const mine=plays.find(x=>x.seat===other);
    if(mine&&leadClass(mine.card)!==cls)return true;
  }
  return false;
}
function highestUnseenTrumpIndex(room,seat){
  const unseen=unseenCards(room,seat).filter(isTrump);
  return unseen.length?Math.min(...unseen.map(c=>TRUMP_ORDER.indexOf(c.id))):99;
}
function isMasterTrump(room,seat,c){return isTrump(c)&&TRUMP_ORDER.indexOf(c.id)<highestUnseenTrumpIndex(room,seat)}
function botLead(room,seat,legal){
  const g=room.game,p=room.players[seat],tr=legal.filter(isTrump),off=legal.filter(c=>!isTrump(c));
  const offAces=off.filter(c=>c.r==='A');
  if(g.mode==='leaster'){
    const needTrick=(p.tricks.length===0&&g.trickNo>=4);
    if(needTrick){
      const masters=legal.filter(c=>isMasterTrump(room,seat,c));
      if(masters.length)return lowToHigh(masters)[0];
      if(offAces.length)return offAces[0];
    }
    return [...legal].sort((a,b)=>(POINTS[a.r]*35+strength(a))-(POINTS[b.r]*35+strength(b)))[0];
  }
  const called=g.calledSuit;
  const calledCards=off.filter(c=>c.s===called);
  if(seat===g.picker){
    // Pull trump while control is good. Master trump is especially valuable early.
    if(g.trickNo<=2&&tr.length>=2){
      const master=tr.find(c=>isMasterTrump(room,seat,c));
      if(master)return master;
      const ordered=[...tr].sort((a,b)=>TRUMP_ORDER.indexOf(a.id)-TRUMP_ORDER.indexOf(b.id));
      return ordered[Math.min(ordered.length-1,Math.max(0,Math.floor(ordered.length/2)-1))];
    }
    // After drawing trump, lead the called suit low to force the partner ace/reveal.
    if(!g.partnerRevealed&&calledCards.length)return [...calledCards].sort((a,b)=>strength(a)-strength(b))[0];
    if(offAces.length)return offAces[0];
    if(tr.length)return lowToHigh(tr)[0];
  }
  if(seat===g.partner){
    const safeAce=offAces.find(c=>!called||c.s!==called);
    if(safeAce)return safeAce;
    if(off.length)return lowToHigh(off)[0];
    return lowToHigh(tr)[0];
  }
  // Defenders often want to force the called ace early to expose the partner.
  if(!g.partnerRevealed&&calledCards.length)return [...calledCards].sort((a,b)=>strength(a)-strength(b))[0];
  if(offAces.length)return offAces[0];
  if(off.length){
    return [...off].sort((a,b)=>{
      const ca=p.hand.filter(c=>!isTrump(c)&&c.s===a.s).length,cb=p.hand.filter(c=>!isTrump(c)&&c.s===b.s).length;
      return ca-cb||strength(a)-strength(b);
    })[0];
  }
  return lowToHigh(tr)[0];
}
function botPlay(room,seat){
  const g=room.game,p=room.players[seat],legal=legalCardsFor(room,seat);
  if(!legal.length)return null;
  if(!g.trick.length)return botLead(room,seat,legal).id;
  const leadCls=leadClass(g.trick[0].card),lead=leadCls==='T'?null:leadCls;
  const current=trickWinner(g.trick),pts=trickPoints(g.trick),last=g.trick.length===4;
  const winners=legal.filter(c=>cardBeats(c,current.card,lead));
  const losers=legal.filter(c=>!cardBeats(c,current.card,lead));
  if(g.mode==='leaster'){
    const needTrick=p.tricks.length===0&&g.trickNo>=4;
    if(!needTrick&&losers.length)return [...losers].sort((a,b)=>(POINTS[a.r]*35+strength(a))-(POINTS[b.r]*35+strength(b)))[0].id;
    if(winners.length)return [...winners].sort((a,b)=>(POINTS[a.r]*35+strength(a))-(POINTS[b.r]*35+strength(b)))[0].id;
    return lowToHigh(legal)[0].id;
  }
  const teammateWinning=knownSameTeam(g,seat,current.seat);
  if(teammateWinning){
    if(last){
      // Nobody can overtake after us: smear the largest point card that still loses.
      if(losers.length)return [...losers].sort((a,b)=>(POINTS[b.r]-POINTS[a.r])||(strength(a)-strength(b)))[0].id;
      return lowToHigh(legal)[0].id;
    }
    // Earlier in trick, feed points only if we can do it without spending trump/high control.
    const safe=losers.filter(c=>!isTrump(c));
    if(safe.length)return [...safe].sort((a,b)=>(POINTS[b.r]-POINTS[a.r])||(strength(a)-strength(b)))[0].id;
    if(losers.length)return lowToHigh(losers)[0].id;
    return lowToHigh(legal)[0].id;
  }
  if(winners.length){
    const cheapest=cheapWinner(legal,current,lead);
    const currentIsPicker=current.seat===g.picker;
    const master=isMasterTrump(room,seat,cheapest);
    // Last seat has perfect information. Earlier seats capture valuable tricks,
    // picker tricks, or use cheap/master winners; otherwise preserve control.
    if(last||pts>=8||currentIsPicker||POINTS[cheapest.r]<=4||master)return cheapest.id;
  }
  const pool=losers.length?losers:legal;
  return [...pool].sort((a,b)=>{
    // Avoid donating A/10 and avoid wasting trump when an opponent already owns the trick.
    const riskA=POINTS[a.r]*11+(isTrump(a)?Math.max(0,18-TRUMP_ORDER.indexOf(a.id))*2.2:0);
    const riskB=POINTS[b.r]*11+(isTrump(b)?Math.max(0,18-TRUMP_ORDER.indexOf(b.id))*2.2:0);
    return riskA-riskB||strength(a)-strength(b);
  })[0].id;
}
function botDoubleDecision(room,x){
  const g=room.game,score=botPickScore(x.p.hand),trumps=x.p.hand.filter(isTrump).length,top=x.p.hand.filter(c=>['QC','QS','QH','QD','JC','JS'].includes(c.id)).length;
  if(room.settings.blitzers){for(const t of ['BLACK','RED'])if(canBlitzHand(x.p.hand,t)&&!g.blitzedBy.some(y=>y.seat===x.i&&y.type===t))return t}
  // Cracks are intentionally selective: bad cracks are much more expensive than passes.
  if(room.settings.cracking&&g.crackCount===0&&eligibleCrackers(room).includes(x.i)&&score>=27&&trumps>=4&&top>=1)return 'CRACK';
  if(room.settings.cracking&&g.crackCount===1&&(x.i===g.picker||x.i===g.partner)&&score>=29&&trumps>=4)return 'RECRACK';
  return null;
}
function fallbackBotDiscard(hand){
  const score=c=>{let v=(isTrump(c)?80:0)+POINTS[c.r]*2;if(['A','10'].includes(c.r)&&!isTrump(c))v+=24;return v};
  return [...hand].sort((a,b)=>score(a)-score(b)).slice(0,2).map(c=>c.id);
}
function fallbackBotCall(hand){
  const suits=['C','S','H'].filter(s=>!hand.some(c=>c.r==='A'&&c.s===s)&&hand.some(c=>!isTrump(c)&&c.s===s));
  return suits[0]||'ALONE';
}
function fallbackBotPlay(room,seat){
  const g=room.game,p=room.players[seat],legal=legalCardsFor(room,seat);
  if(!legal.length)return null;
  if(g.mode==='leaster')return [...legal].sort((a,b)=>(POINTS[a.r]*20+strength(a))-(POINTS[b.r]*20+strength(b)))[0].id;
  if(!g.trick.length){const off=legal.filter(c=>!isTrump(c)).sort((a,b)=>strength(a)-strength(b));return (off[0]||[...legal].sort((a,b)=>strength(a)-strength(b))[0]).id}
  const current=trickWinner(g.trick),lead=leadClass(g.trick[0].card)==='T'?null:leadClass(g.trick[0].card);
  const winners=legal.filter(c=>cardBeats(c,current.card,lead)).sort((a,b)=>strength(a)-strength(b));
  return (winners[0]||[...legal].sort((a,b)=>strength(a)-strength(b))[0]).id;
}
function scheduleBots(room){
  if(!room?.game)return;

  // Doubling is not a turn-based phase. Give one bot at a time a chance to
  // make a declaration; applyDouble() calls scheduleBots() again afterward.
  if(room.phase==='doubling'){
    for(const x of room.players.map((p,i)=>({p,i})).filter(x=>x.p.isBot)){
      let move=null;
      try{ move=botDoubleDecision(room,x); }catch(err){ console.error('Bot double decision failed:',err); }
      if(move){
        return setTimeout(()=>{
          if(room.phase==='doubling')applyDouble(room,x.i,move);
        },700);
      }
    }
    return;
  }

  let seat=null;
  if(room.phase==='discard'||room.phase==='call')seat=room.game.picker;
  else if(['picking','playing','leaster'].includes(room.phase))seat=room.game.current;
  else return;

  const p=room.players[seat];
  if(!p?.isBot)return;
  const expectedPhase=room.phase;

  setTimeout(()=>{
    // Re-read current state when the timer fires. If this bot no longer owns
    // the turn, simply schedule the current bot rather than freezing the game.
    if(!room.game)return;
    const currentSeat=(room.phase==='discard'||room.phase==='call')?room.game.picker:room.game.current;
    if(room.phase!==expectedPhase||currentSeat!==seat||!room.players[seat]?.isBot){
      return scheduleBots(room);
    }

    try{
      if(room.phase==='picking'){
        let pick;
        try{pick=botShouldPick(room,seat)}catch(err){console.error('Smart bot pick failed:',err);pick=handPower(p.hand)>19||(room.game.passed.length>=3&&handPower(p.hand)>16)}
        return actPick(room,seat,!!pick);
      }
      if(room.phase==='discard'){
        if(runBotDiscard(room,seat))return;
        // Watchdog: if a malformed hand/state ever prevents the smart discard,
        // retry from fresh room state instead of leaving the table frozen.
        console.error(`[BOT] discard retry for seat ${seat}`);
        return setTimeout(()=>{
          if(room.phase==='discard'&&room.game?.picker===seat&&room.players[seat]?.isBot){
            if(!runBotDiscard(room,seat)){
              const fresh=room.players[seat]?.hand||[];
              if(fresh.length>=2){
                const ids=fresh.slice(-2).map(c=>c.id);
                const cards=ids.map(id=>fresh.find(c=>c.id===id)).filter(Boolean);
                const bury=new Set(ids);
                room.players[seat].hand=fresh.filter(c=>!bury.has(c.id));
                room.game.discard=cards;
                room.phase='call';
                room.message=`${room.players[seat].name} buried two cards and is choosing a partner.`;
                emit(room);scheduleBots(room);
              }
            }
          }
        },250);
      }
      if(room.phase==='call'){
        let suit;
        try{suit=botCallChoice(p.hand)}catch(err){console.error('Smart bot call failed:',err);suit=fallbackBotCall(p.hand)}
        const before=room.phase;
        callPartner(room,seat,suit);
        // If a smart call was rejected by a house-rule edge case, make a safe call.
        if(room.phase===before)callPartner(room,seat,fallbackBotCall(p.hand));
        return;
      }
      if(room.phase==='playing'||room.phase==='leaster'){
        let id;
        try{id=botPlay(room,seat)}catch(err){console.error('Smart bot play failed:',err);id=fallbackBotPlay(room,seat)}
        const legal=legalCardsFor(room,seat).map(c=>c.id);
        if(!legal.includes(id))id=fallbackBotPlay(room,seat);
        if(id)return playCard(room,seat,id);
      }
    }catch(err){
      console.error('Bot turn failed:',err);
      // Last-resort fallback: never leave a bot turn permanently stuck.
      if(room.phase==='picking'&&room.game.current===seat)return actPick(room,seat,handPower(p.hand)>18);
      if(room.phase==='discard'&&room.game.picker===seat){if(runBotDiscard(room,seat))return;const h=room.players[seat]?.hand||[];if(h.length>=2)return discard(room,seat,[h[0].id,h[1].id]);}
      if(room.phase==='call'&&room.game.picker===seat)return callPartner(room,seat,fallbackBotCall(p.hand));
      if(['playing','leaster'].includes(room.phase)&&room.game.current===seat){const id=fallbackBotPlay(room,seat);if(id)return playCard(room,seat,id)}
    }
  },950+randomInt(451));
}

function markReady(room,socketId,kind){
  if(!room||!humanIds(room).includes(socketId))return;
  const allowed={lobby:'START',doubling:'PLAY',trickEnd:'TRICK',roundEnd:'ROUND'};
  if(allowed[room.phase]!==kind)return;
  room.readySet??=new Set();room.readySet.add(socketId);
  const info=readyInfo(room,socketId);room.message=`${info.ready}/${info.needed} human player${info.needed===1?'':'s'} ready.`;emit(room);
  if(!allHumansReady(room))return;
  if(room.phase==='lobby')startRound(room);
  else if(room.phase==='doubling')beginPlay(room);
  else if(room.phase==='trickEnd')advanceAfterTrick(room);
  else if(room.phase==='roundEnd')startRound(room);
}
function maybeAdvanceBarrier(room){if(!room||!['lobby','doubling','trickEnd','roundEnd'].includes(room.phase)||!allHumansReady(room))return;if(room.phase==='lobby')startRound(room);else if(room.phase==='doubling')beginPlay(room);else if(room.phase==='trickEnd')advanceAfterTrick(room);else if(room.phase==='roundEnd')startRound(room)}

io.on('connection',socket=>{
 socket.on('createRoom',({name,avatar,settings,mode,authToken})=>{const accountId=tokenUserId(authToken),roomMode=mode==='single'?'single':'multiplayer',code=roomCode(),player=createPlayer((name||'Player').slice(0,18),socket.id,false,String(avatar||'🙂').slice(0,8),accountId),room={code,mode:roomMode,hostId:socket.id,players:[player],phase:'lobby',game:null,message:roomMode==='single'?'Single player ready. Press Start game when you are ready.':'Invite friends. Every human presses Start when ready.',settings:clampSettings(settings),history:[],roundNumber:0,nextMultiplier:1,readySet:new Set(),pendingDeal:null};rooms.set(code,room);socket.join(code);socket.data.code=code;emit(room)});
 socket.on('joinRoom',({code,name,avatar,password,authToken})=>{const accountId=tokenUserId(authToken);code=(code||'').toUpperCase().trim();const room=rooms.get(code);if(!room)return socket.emit('errorMsg','Room not found.');if(room.mode==='single')return socket.emit('errorMsg','That is a single-player table.');if(room.phase!=='lobby')return socket.emit('errorMsg','That game already started.');if(room.settings.password&&String(password||'')!==room.settings.password)return socket.emit('errorMsg','Wrong table password.');if(room.players.length>=5)return socket.emit('errorMsg','Room is full.');room.players.push(createPlayer((name||'Player').slice(0,18),socket.id,false,String(avatar||'🙂').slice(0,8),accountId));socket.join(code);socket.data.code=code;room.message='Every human presses Start when ready.';emit(room)});
 socket.on('readyStart',()=>markReady(rooms.get(socket.data.code),socket.id,'START'));
 socket.on('readyPlay',()=>markReady(rooms.get(socket.data.code),socket.id,'PLAY'));
 socket.on('nextTrick',()=>markReady(rooms.get(socket.data.code),socket.id,'TRICK'));
 socket.on('nextRound',()=>markReady(rooms.get(socket.data.code),socket.id,'ROUND'));
 socket.on('pick',({pick})=>{const room=rooms.get(socket.data.code);if(room)actPick(room,room.players.findIndex(p=>p.id===socket.id),!!pick)});
 socket.on('discard',({ids})=>{const room=rooms.get(socket.data.code);if(room)discard(room,room.players.findIndex(p=>p.id===socket.id),ids)});
 socket.on('call',({suit})=>{const room=rooms.get(socket.data.code);if(room)callPartner(room,room.players.findIndex(p=>p.id===socket.id),suit)});
 socket.on('double',({type})=>{const room=rooms.get(socket.data.code);if(room)applyDouble(room,room.players.findIndex(p=>p.id===socket.id),type)});
 socket.on('play',({id})=>{const room=rooms.get(socket.data.code);if(room)playCard(room,room.players.findIndex(p=>p.id===socket.id),id)});
 socket.on('disconnect',()=>{const room=rooms.get(socket.data.code);if(!room)return;const p=room.players.find(p=>p.id===socket.id);if(p){p.connected=false;room.readySet?.delete(socket.id);if(room.phase==='lobby')room.players=room.players.filter(x=>x.id!==socket.id);else{p.isBot=true;p.name=p.name.replace(/ \(Bot\)$/,'')+' (Bot)';scheduleBots(room)}emit(room);maybeAdvanceBarrier(room)}})
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Sheepshead running on http://0.0.0.0:${PORT}`));
